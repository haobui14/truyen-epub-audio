"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useSearchParams, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn, isAdmin, getToken } from "@/lib/auth";
import { ChapterList } from "@/components/books/ChapterList";
import { ChapterPickerSheet } from "@/components/books/ChapterPickerSheet";
import { Spinner } from "@/components/ui/Spinner";
import { AsyncState } from "@/components/ui/AsyncState";
import { ConnectivityStatus } from "@/components/ui/ConnectivityStatus";
import { GenreTag } from "@/components/books/GenreManager";
import {
  getCachedChapterEntry,
  canUseCachedChapterText,
  evictChapterText,
} from "@/lib/chapterTextCache";
import { getLocalBookProgress } from "@/lib/progressQueue";
import { isNativePlatform } from "@/lib/capacitor";
import { getTtsBridge } from "@/lib/backgroundLock";
import {
  getCachedBook,
  cacheBook,
  getCachedChapters,
  cacheChapters,
  cacheAllChapters,
  getCachedCover,
  cacheCover,
} from "@/lib/bookCache";
import type { Chapter } from "@/types";
import { API_URL } from "@/lib/constants";
import { reportClientBreadcrumb } from "@/lib/errorReporter";
import {
  classifyOfflineError,
  getOfflineRepository,
  utf8Bytes,
  type OfflineBookState,
} from "@/lib/offlineRepository";

export default function BookDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const bookId = (searchParams.get("id") ||
    (params?.bookId as string) ||
    "") as string;
  const [page, setPage] = useState(1);
  const [admin, setAdmin] = useState(false);
  const [coverSrc, setCoverSrc] = useState<string | undefined>(undefined);
  const [usingCachedBook, setUsingCachedBook] = useState(false);
  const [usingCachedChapters, setUsingCachedChapters] = useState(false);
  const offlineRepository = useMemo(() => getOfflineRepository(), []);
  const [offlineState, setOfflineState] = useState<OfflineBookState | null>(null);
  const downloadRunRef = useRef(0);
  const [epubState, setEpubState] = useState<"idle" | "working" | "done">(
    "idle",
  );
  const [epubError, setEpubError] = useState<string | null>(null);
  // Shown when a guest taps a button whose endpoint now needs an approved
  // account — friendlier than letting the request come back 401.
  const [gateMsg, setGateMsg] = useState<string | null>(null);
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false);

  useEffect(() => {
    const sync = () => setAdmin(isAdmin());
    sync();
    window.addEventListener("auth-change", sync);
    return () => window.removeEventListener("auth-change", sync);
  }, []);

  useEffect(() => {
    if (!bookId) return;
    if (isNativePlatform()) {
      getCachedCover(bookId)
        .then((cached) => setCoverSrc(cached ?? undefined))
        .catch(() => {});
    }
  }, [bookId]);

  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void offlineRepository.getBookState(bookId).then((state) => {
      if (!cancelled) setOfflineState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [bookId, offlineRepository]);

  useEffect(() => {
    if (!bookId || offlineState?.status !== "downloading") return;
    let cancelled = false;
    const refresh = async () => {
      const next = await offlineRepository.getBookState(bookId);
      if (!cancelled && next) setOfflineState(next);
    };
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bookId, offlineRepository, offlineState?.status]);

  const {
    data: book,
    isLoading: bookLoading,
    error: bookError,
    refetch: refetchBook,
  } = useQuery({
    queryKey: ["book", bookId],
    queryFn: async () => {
      try {
        const data = await api.getBook(bookId);
        setUsingCachedBook(false);
        cacheBook(data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedBook(bookId);
        if (cached) {
          setUsingCachedBook(true);
          return cached;
        }
        throw new Error("offline");
      }
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "parsing" ? 2000 : false;
    },
    // Fresh-for-10-min on mount; the parsing poll above still fires on its
    // own interval, and app-foreground invalidation still forces a refetch.
    staleTime: 10 * 60_000,
  });

  const isParsing = book?.status === "pending" || book?.status === "parsing";

  const {
    data: chaptersData,
    isLoading: chaptersLoading,
    refetch: refetchChapters,
  } = useQuery({
    queryKey: ["chapters", bookId, page],
    queryFn: async () => {
      try {
        const data = await api.getBookChapters(bookId, page);
        setUsingCachedChapters(false);
        cacheChapters(bookId, page, data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedChapters(bookId, page);
        if (cached) {
          setUsingCachedChapters(true);
          return cached;
        }
        throw new Error("offline");
      }
    },
    enabled: !!book && !isParsing,
    staleTime: 10 * 60_000,
  });

  const { data: bookProgress } = useQuery({
    queryKey: ["bookProgress", bookId],
    queryFn: async () => {
      // IndexedDB book pointer — the offline fallback for accounts, and the
      // ONLY store guests have. Keeps "Nghe tiếp"/"Đọc tiếp" working without
      // an account (device-local; an account adds cross-device sync).
      const fromLocal = async () => {
        const local = await getLocalBookProgress(bookId);
        if (!local) return null;
        return {
          id: "",
          user_id: "",
          book_id: local.book_id,
          chapter_id: local.chapter_id,
          progress_value: local.progress_value,
          total_value: local.total_value,
          updated_at: new Date(local.updated_at).toISOString(),
        };
      };
      if (!isLoggedIn()) return fromLocal();
      try {
        return await api.getBookProgress(bookId);
      } catch {
        return fromLocal();
      }
    },
    enabled: !!book,
  });

  const lastListenChapterId = useMemo(
    () => localStorage.getItem(`listen-chapter:${bookId}`),
    [bookId],
  );

  // The native service knows the TRUE last listening position — including
  // chapters reached while the screen was off and sessions restored after a
  // process kill — which localStorage (only written while /listen is open)
  // can trail by dozens of chapters.
  const nativeListenChapterId = useMemo(() => {
    if (!isNativePlatform()) return null;
    try {
      const bridge = getTtsBridge();
      if (!bridge) return null;
      // Live (or restored) session first.
      if ((bridge.getCurrentBookId?.() ?? "") === bookId) {
        const id = bridge.getCurrentChapterId?.() || "";
        if (id) return id;
      }
      // Durable last-position: survives stop / swipe-away / process death.
      // Honored only when fresher than this device's localStorage pointer
      // (a later /listen visit without playing must still win).
      const raw = bridge.getLastListenPosition?.() ?? "";
      if (raw) {
        const last = JSON.parse(raw) as {
          bookId?: string;
          chapterId?: string;
          ts?: number;
        };
        if (last.bookId === bookId && last.chapterId) {
          const localTs = Number(
            localStorage.getItem(`listen-chapter-ts:${bookId}`) ?? 0,
          );
          if ((last.ts ?? 0) >= localTs) return last.chapterId;
        }
      }
      return null;
    } catch {
      return null;
    }
  }, [bookId]);

  async function handleDownloadBook() {
    if (offlineState?.status === "downloading") return;
    if (!isLoggedIn()) {
      setGateMsg("Cần đăng nhập để tải truyện về máy");
      return;
    }
    const runId = ++downloadRunRef.current;
    const startedAt = Date.now();
    let state: OfflineBookState = {
      book_id: bookId,
      book_title: book?.title ?? "",
      status: "downloading",
      total_chapters: offlineState?.total_chapters ?? 0,
      completed_chapters: offlineState?.completed_chapters ?? 0,
      failed_chapters: 0,
      stale_chapters: 0,
      bytes_total: offlineState?.bytes_total ?? 0,
      chapter_ids: offlineState?.chapter_ids ?? [],
      failed_chapter_ids: [],
      version: offlineState?.version ?? null,
      last_successful_sync: offlineState?.last_successful_sync ?? null,
      updated_at: startedAt,
    };
    const persist = async (next: OfflineBookState) => {
      state = next;
      setOfflineState(next);
      await offlineRepository.saveBookState(next);
    };

    try {
      await persist(state);
      if (book) await cacheBook(book);

      if (book?.cover_url) {
        try {
        const resp = await fetch(book.cover_url);
        if (!resp.ok) throw new Error(`cover-${resp.status}`);
        const blob = await resp.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        await cacheCover(bookId, dataUrl);
        setCoverSrc(dataUrl);
        } catch {
          // The text download remains useful when a remote cover is unavailable.
        }
      }

      const PAGE_SIZE = 1000;
      const allChapters: Chapter[] = [];
      let lastRes: Awaited<ReturnType<typeof api.getBookChapters>> | null = null;
      let pg = 1;
      while (true) {
        const res = await api.getBookChapters(bookId, pg, PAGE_SIZE);
        await cacheChapters(bookId, pg, res);
        allChapters.push(...res.items);
        lastRes = res;
        if (pg >= res.total_pages) break;
        pg++;
      }
      if (lastRes && allChapters.length > 0) {
        await cacheAllChapters(bookId, {
          ...lastRes,
          items: allChapters,
          total: allChapters.length,
          page: 1,
          total_pages: 1,
        });
      }

      const total = allChapters.length;
      const chapterIds = new Set<string>();
      const failedIds: string[] = [];
      let completed = 0;
      let stale = 0;
      let bytes = 0;
      const version =
        allChapters.map((chapter) => chapter.updated_at).sort().at(-1) ?? null;
      await persist({
        ...state,
        total_chapters: total,
        completed_chapters: 0,
        version,
        updated_at: Date.now(),
      });

      if (offlineRepository.enqueueBookDownload) {
        // Import only complete, current legacy IndexedDB entries. Deleting after
        // the native write succeeds makes this migration recoverable.
        let migrated = 0;
        for (const chapter of allChapters) {
          const legacy = await getCachedChapterEntry(chapter.id);
          if (!legacy || !canUseCachedChapterText(legacy, chapter.updated_at)) {
            continue;
          }
          const chapterBytes = utf8Bytes(legacy.text_content);
          await offlineRepository.saveChapter({
            id: chapter.id,
            book_id: bookId,
            text_content: legacy.text_content,
            cached_at: legacy.cached_at,
            server_updated_at: legacy.server_updated_at,
            bytes: chapterBytes,
          });
          await evictChapterText(chapter.id);
          migrated++;
        }
        await offlineRepository.enqueueBookDownload({
          bookId,
          bookTitle: book?.title ?? "",
          chapters: allChapters.map(({ id, updated_at }) => ({
            id,
            updated_at,
          })),
          apiBase: API_URL,
        });
        reportClientBreadcrumb("download", "queued", "work-manager", {
          book_id: bookId,
          chapter_count: total,
          migrated_chapters: migrated,
        });
        return;
      }

      for (const ch of allChapters) {
        if (downloadRunRef.current !== runId) {
          await persist({
            ...state,
            status: completed > 0 ? "partial" : "error",
            completed_chapters: completed,
            failed_chapters: failedIds.length,
            stale_chapters: stale,
            bytes_total: bytes,
            chapter_ids: [...chapterIds],
            failed_chapter_ids: failedIds,
            updated_at: Date.now(),
            error_code: "cancelled",
            error_message: "Đã dừng tải. Bạn có thể tiếp tục bất cứ lúc nào.",
          });
          return;
        }

        const cached = await getCachedChapterEntry(ch.id);
        const isFresh = !!cached && canUseCachedChapterText(cached, ch.updated_at);
        try {
          if (isFresh && cached) {
            chapterIds.add(ch.id);
            completed++;
            bytes += utf8Bytes(cached.text_content);
          } else {
            const result = await api.getChapterText(ch.id);
            const chapterBytes = utf8Bytes(result.text_content);
            await offlineRepository.saveChapter({
              id: ch.id,
              book_id: bookId,
              text_content: result.text_content,
              cached_at: Date.now(),
              server_updated_at: result.updated_at,
              bytes: chapterBytes,
            });
            chapterIds.add(ch.id);
            completed++;
            bytes += chapterBytes;
          }
        } catch {
          failedIds.push(ch.id);
          if (cached && !isFresh) stale++;
        }
        await persist({
          ...state,
          status: "downloading",
          completed_chapters: completed,
          failed_chapters: failedIds.length,
          stale_chapters: stale,
          bytes_total: bytes,
          chapter_ids: [...chapterIds],
          failed_chapter_ids: [...failedIds],
          updated_at: Date.now(),
        });
      }

      await persist({
        ...state,
        status: failedIds.length > 0 ? "partial" : "ready",
        completed_chapters: completed,
        failed_chapters: failedIds.length,
        stale_chapters: stale,
        bytes_total: bytes,
        chapter_ids: [...chapterIds],
        failed_chapter_ids: failedIds,
        last_successful_sync: failedIds.length === 0 ? Date.now() : state.last_successful_sync,
        updated_at: Date.now(),
        error_code: failedIds.length > 0 ? "network" : undefined,
        error_message:
          failedIds.length > 0
            ? `${failedIds.length} chương chưa tải được. Nhấn để thử lại.`
            : undefined,
      });
      reportClientBreadcrumb(
        "download",
        failedIds.length > 0 ? "partial" : "complete",
        "web-adapter",
        {
          book_id: bookId,
          completed_chapters: completed,
          failed_chapters: failedIds.length,
        },
      );
    } catch (error) {
      const failure = classifyOfflineError(error);
      await persist({
        ...state,
        status: state.completed_chapters > 0 ? "partial" : "error",
        updated_at: Date.now(),
        ...failure,
      });
      reportClientBreadcrumb("download", "failed", "repository", {
        book_id: bookId,
        error_code: failure.error_code,
      });
    }
  }

  async function handleCancelDownload() {
    downloadRunRef.current++;
    await offlineRepository.cancelBookDownload?.(bookId);
    const next = await offlineRepository.getBookState(bookId);
    setOfflineState(next);
    reportClientBreadcrumb("download", "cancelled", offlineRepository.platform, {
      book_id: bookId,
    });
  }

  async function handleRemoveOfflineBook() {
    downloadRunRef.current++;
    await offlineRepository.removeBook(bookId);
    setOfflineState(null);
    setCoverSrc(undefined);
    reportClientBreadcrumb("download", "removed", offlineRepository.platform, {
      book_id: bookId,
    });
  }

  async function handleDownloadEpub() {
    if (epubState === "working") return;
    setEpubError(null);
    if (!isLoggedIn()) {
      setGateMsg("Cần đăng nhập để tải file EPUB");
      return;
    }
    const fileName =
      `${(book?.title ?? "").replace(/[\\/:*?"<>|]+/g, " ").trim() || "truyen"}.epub`;

    // Native: the WebView cannot save files itself — hand the URL to Android's
    // DownloadManager, which shows progress + completion in the system shade.
    if (isNativePlatform()) {
      const bridge = getTtsBridge();
      if (bridge?.downloadFile) {
        bridge.downloadFile(
          api.bookEpubUrl(bookId),
          fileName,
          getToken() ?? "",
        );
        setEpubState("done");
      } else {
        setEpubError("Cần cập nhật ứng dụng để tải file EPUB");
      }
      return;
    }

    setEpubState("working");
    try {
      const blob = await api.fetchBookEpub(bookId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser time to grab the blob before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setEpubState("done");
    } catch (e) {
      setEpubState("idle");
      setEpubError(
        e instanceof Error ? e.message : "Không tải được file EPUB",
      );
    }
  }

  if (bookLoading) {
    return <AsyncState kind="loading" title="Đang tải truyện" />;
  }

  if (!book) {
    return (
      <AsyncState
        kind={bookError ? "error" : "empty"}
        title={bookError ? "Không thể tải truyện" : "Không tìm thấy truyện"}
        message={bookError ? "Hãy kiểm tra kết nối và thử lại." : undefined}
        onAction={bookError ? () => void refetchBook() : undefined}
      />
    );
  }

  const chapters = chaptersData?.items ?? [];
  const firstChapter = chapters[0] ?? null;

  const listenResumeId =
    nativeListenChapterId ??
    lastListenChapterId ??
    bookProgress?.chapter_id ??
    firstChapter?.id;
  const readResumeId = bookProgress?.chapter_id ?? firstChapter?.id;
  const hasProgress =
    !!bookProgress || !!lastListenChapterId || !!nativeListenChapterId;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-4">
        <ConnectivityStatus cached={usingCachedBook || usingCachedChapters} />
      </div>
      {/* Breadcrumb */}
      <nav className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase text-text-mute min-w-0">
          <Link
            href="/"
            className="hover:text-accent transition-colors shrink-0"
          >
            Thư viện
          </Link>
          <svg
            className="w-3 h-3 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
          <span className="text-text font-medium truncate max-w-xs normal-case tracking-normal">
            {book.title}
          </span>
        </div>
        {admin && (
          <Link
            href={`/admin/edit-book?id=${bookId}`}
            className="shrink-0 ml-3 inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] tracking-widest uppercase text-vermillion border border-vermillion/40 rounded-sm hover:bg-vermillion/10 transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            Chỉnh sửa
          </Link>
        )}
      </nav>

      {/* Book header card */}
      <div className="bg-surface rounded-lg ring-1 ring-hairline shadow-[0_20px_50px_rgba(0,0,0,0.45)] overflow-hidden mb-6">
        <div className="flex gap-5 sm:gap-6 p-5 sm:p-6">
          <div className="w-28 sm:w-32 h-40 sm:h-44 rounded-md overflow-hidden bg-raised ring-1 ring-hairline-soft shrink-0 shadow-[0_8px_22px_rgba(0,0,0,0.5)]">
            {coverSrc ?? book.cover_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverSrc ?? book.cover_url!}
                alt={book.title}
                className="object-cover w-full h-full"
                onError={() => {
                  if (!coverSrc && book.cover_url) {
                    getCachedCover(bookId)
                      .then((c) => {
                        if (c) setCoverSrc(c);
                      })
                      .catch(() => {});
                  }
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-text-faint">
                <svg
                  className="w-14 h-14"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1">
              <h1 className="font-display text-2xl sm:text-3xl text-text mb-1.5 leading-tight">
                {book.title}
              </h1>
              {book.author && (
                <p className="font-display italic text-sm text-text-mute mb-3">
                  {book.author}
                </p>
              )}
              {book.description && (
                <p className="text-sm text-text-mute mb-3 leading-relaxed line-clamp-3">
                  {book.description}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-widest uppercase text-text-faint mb-3">
                {book.total_chapters > 0 && (
                  <span className="flex items-center gap-1">
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 12h16M4 18h7"
                      />
                    </svg>
                    {book.total_chapters} chương
                  </span>
                )}
              </div>
              {book.genres && book.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {book.genres.map((g) => (
                    <GenreTag key={g.id} genre={g} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        {isParsing ? (
          <div className="flex items-center gap-3 mx-5 sm:mx-6 mb-5 sm:mb-6 px-4 py-3.5 rounded-md bg-gold/10 border border-gold/30">
            <Spinner className="w-5 h-5 text-gold shrink-0" />
            <div>
              <p className="text-sm font-medium text-gold">
                Đang xử lý file EPUB...
              </p>
              <p className="text-xs text-gold-dim mt-0.5">
                Sẽ sẵn sàng trong giây lát
              </p>
            </div>
          </div>
        ) : firstChapter ? (
          <div className="flex flex-col gap-3 mx-5 sm:mx-6 mb-5 sm:mb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Link
                href={
                  listenResumeId
                    ? `/listen?id=${bookId}&chapter=${listenResumeId}`
                    : "#"
                }
                className="min-h-11 flex items-center gap-3 px-4 py-3.5 rounded-md bg-accent hover:bg-accent-dim active:scale-[0.96] transition-[transform,background-color,box-shadow] text-ink group shadow-[0_0_24px_var(--color-accent-glow)]"
              >
                <div className="w-10 h-10 rounded-full bg-ink/15 flex items-center justify-center shrink-0 group-hover:bg-ink/25 transition-colors">
                  <svg
                    className="w-4 h-4 ml-0.5"
                    fill="currentColor"
                    viewBox="0 0 14 14"
                  >
                    <path d="M3 1l10 6-10 6V1z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm">
                    {hasProgress ? "Nghe tiếp" : "Nghe ngay"}
                  </p>
                  <p className="font-mono text-[10px] tracking-widest uppercase text-ink/70 mt-0.5">
                    {hasProgress ? "Tiếp tục từ chỗ dừng" : "TTS trực tiếp"}
                  </p>
                </div>
              </Link>
              <Link
                href={
                  readResumeId
                    ? `/read?id=${bookId}&chapter=${readResumeId}`
                    : "#"
                }
                className="min-h-11 flex items-center gap-3 px-4 py-3.5 rounded-md bg-raised hover:bg-raised-hi active:scale-[0.96] transition-[transform,background-color,box-shadow] text-text-dim group ring-1 ring-hairline"
              >
                <div className="w-10 h-10 rounded-full bg-raised-hi flex items-center justify-center shrink-0 group-hover:bg-hairline transition-colors">
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                    />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-text">
                    {hasProgress ? "Đọc tiếp" : "Đọc truyện"}
                  </p>
                  <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint mt-0.5">
                    {hasProgress ? "Tiếp tục từ chỗ dừng" : "Đọc văn bản"}
                  </p>
                </div>
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={handleDownloadBook}
                disabled={offlineState?.status === "downloading"}
                title={
                  offlineState?.status === "ready"
                    ? "Nhấn để kiểm tra chương mới/đã sửa"
                    : undefined
                }
                className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-[color,background-color,border-color,opacity,transform] active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 ${
                  offlineState?.status === "ready"
                    ? "border-accent/40 text-accent bg-accent/10 hover:bg-accent/15"
                    : offlineState?.status === "downloading"
                      ? "border-accent/40 text-accent bg-accent/10"
                      : offlineState?.status === "partial" || offlineState?.status === "error"
                        ? "border-gold/40 text-gold bg-gold/10 hover:bg-gold/15"
                      : "border-hairline text-text-mute hover:border-accent/40 hover:text-accent hover:bg-accent/10"
                }`}
              >
                {offlineState?.status === "downloading" ? (
                  <>
                    <Spinner className="w-4 h-4" />
                    <span>
                      Đang tải... {offlineState.completed_chapters + offlineState.failed_chapters}/{offlineState.total_chapters || "?"}
                    </span>
                  </>
                ) : offlineState?.status === "ready" ? (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    <span>Đã tải · Kiểm tra cập nhật</span>
                  </>
                ) : offlineState?.status === "partial" ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0011.7 2.6M18.5 9A7 7 0 006.8 6.4" />
                    </svg>
                    <span>Thử lại {offlineState.failed_chapters} chương</span>
                  </>
                ) : offlineState?.status === "error" ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 4h.01M10.3 4.5L3 17a2 2 0 001.7 3h14.6a2 2 0 001.7-3L13.7 4.5a2 2 0 00-3.4 0z" />
                    </svg>
                    <span>Thử tải lại</span>
                  </>
                ) : (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    <span>Tải truyện offline</span>
                  </>
                )}
              </button>
              <button
                onClick={handleDownloadEpub}
                disabled={epubState === "working"}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-[color,background-color,border-color,opacity,transform] active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 ${
                  epubState === "idle"
                    ? "border-hairline text-text-mute hover:border-accent/40 hover:text-accent hover:bg-accent/10"
                    : "border-accent/40 text-accent bg-accent/10"
                }`}
              >
                {epubState === "working" ? (
                  <>
                    <Spinner className="w-4 h-4" />
                    <span>Đang tạo EPUB...</span>
                  </>
                ) : epubState === "done" ? (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    <span>
                      {isNativePlatform()
                        ? "Đang tải — xem thông báo"
                        : "Đã tải file EPUB"}
                    </span>
                  </>
                ) : (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    <span>Tải file EPUB</span>
                  </>
                )}
              </button>
            </div>
            {offlineState && (
              <div
                className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                  offlineState.status === "ready"
                    ? "border-accent/25 bg-accent/5 text-accent"
                    : offlineState.status === "downloading"
                      ? "border-hairline bg-raised text-text-mute"
                      : "border-gold/30 bg-gold/10 text-gold"
                }`}
                role={offlineState.status === "error" ? "alert" : "status"}
              >
                <span className="min-w-0 flex-1">
                  {offlineState.status === "ready"
                    ? `${offlineState.completed_chapters} chương · ${(offlineState.bytes_total / 1_048_576).toFixed(1)} MB`
                    : offlineState.error_message ??
                      `${offlineState.completed_chapters}/${offlineState.total_chapters} chương đã lưu`}
                </span>
                {offlineState.status === "downloading" ? (
                  <button
                    type="button"
                    onClick={handleCancelDownload}
                    className="min-h-11 rounded-lg px-2 font-semibold underline underline-offset-2 active:scale-[0.96]"
                  >
                    Dừng
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleRemoveOfflineBook}
                    className="min-h-11 rounded-lg px-2 font-semibold text-vermillion underline underline-offset-2 active:scale-[0.96]"
                  >
                    Xóa bản tải
                  </button>
                )}
              </div>
            )}
            {epubError && (
              <p className="text-xs text-vermillion text-center">{epubError}</p>
            )}
            {gateMsg && (
              <p className="text-xs text-vermillion text-center">
                {gateMsg} —{" "}
                <Link href="/login" className="underline hover:text-accent">
                  Đăng nhập
                </Link>
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* Chapter list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-xl text-text">Danh sách chương</h2>
          <div className="flex items-center gap-2">
            {chaptersData && (
              <span className="rounded-sm border border-hairline-soft bg-raised px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-text-mute">
                {chaptersData.total} chương
              </span>
            )}
            <button
              type="button"
              onClick={() => setChapterPickerOpen(true)}
              className="inline-flex min-h-11 items-center rounded-xl border border-hairline px-3 text-xs font-semibold text-accent transition-[border-color,background-color,transform] hover:border-accent/40 hover:bg-accent/10 active:scale-[0.96]"
            >
              Tìm chương
            </button>
          </div>
        </div>
        {chaptersLoading ? (
          <AsyncState compact kind="loading" title="Đang tải danh sách chương" />
        ) : !chaptersData ? (
          <AsyncState
            compact
            kind="error"
            title="Không thể tải danh sách chương"
            message="Dữ liệu đã lưu không có trang này."
            onAction={() => void refetchChapters()}
          />
        ) : (
          <ChapterList
            chapters={chapters}
            bookId={bookId}
            page={chaptersData?.page ?? 1}
            totalPages={chaptersData?.total_pages ?? 1}
            total={chaptersData?.total ?? 0}
            onPageChange={setPage}
          />
        )}
      </div>
      <ChapterPickerSheet
        bookId={bookId}
        open={chapterPickerOpen}
        onClose={() => setChapterPickerOpen(false)}
      />
    </div>
  );
}
