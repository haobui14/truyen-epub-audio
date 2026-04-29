"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useSearchParams, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isLoggedIn, isAdmin } from "@/lib/auth";
import { ChapterList } from "@/components/books/ChapterList";
import { Spinner } from "@/components/ui/Spinner";
import { GenreTag } from "@/components/books/GenreManager";
import { cacheChapterText, isChapterTextCached } from "@/lib/chapterTextCache";
import { getLocalBookProgress } from "@/lib/progressQueue";
import { isNativePlatform } from "@/lib/capacitor";
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

export default function BookDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const bookId = (searchParams.get("id") ||
    (params?.bookId as string) ||
    "") as string;
  const [page, setPage] = useState(1);
  const [admin, setAdmin] = useState(false);
  const [coverSrc, setCoverSrc] = useState<string | undefined>(undefined);
  const [dlProgress, setDlProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [dlDone, setDlDone] = useState(false);

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

  const { data: book, isLoading: bookLoading } = useQuery({
    queryKey: ["book", bookId],
    queryFn: async () => {
      try {
        const data = await api.getBook(bookId);
        cacheBook(data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedBook(bookId);
        if (cached) return cached;
        throw new Error("offline");
      }
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "parsing" ? 2000 : false;
    },
  });

  const isParsing = book?.status === "pending" || book?.status === "parsing";

  const { data: chaptersData, isLoading: chaptersLoading } = useQuery({
    queryKey: ["chapters", bookId, page],
    queryFn: async () => {
      try {
        const data = await api.getBookChapters(bookId, page);
        cacheChapters(bookId, page, data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedChapters(bookId, page);
        if (cached) return cached;
        throw new Error("offline");
      }
    },
    enabled: !!book && !isParsing,
  });

  const { data: bookProgress } = useQuery({
    queryKey: ["bookProgress", bookId],
    queryFn: async () => {
      try {
        return await api.getBookProgress(bookId);
      } catch {
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
      }
    },
    enabled: !!book && isLoggedIn(),
  });

  const lastListenChapterId = useMemo(
    () => localStorage.getItem(`listen-chapter:${bookId}`),
    [bookId],
  );

  async function handleDownloadBook() {
    if (dlProgress) return;
    setDlDone(false);

    if (book) cacheBook(book).catch(() => {});

    if (book?.cover_url) {
      try {
        const resp = await fetch(book.cover_url);
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
        // best-effort
      }
    }

    const PAGE_SIZE = 1000;
    const allChapters: Chapter[] = [];
    let lastRes: Awaited<ReturnType<typeof api.getBookChapters>> | null = null;
    let pg = 1;
    while (true) {
      const res = await api.getBookChapters(bookId, pg, PAGE_SIZE);
      cacheChapters(bookId, pg, res).catch(() => {});
      allChapters.push(...res.items);
      lastRes = res;
      if (pg >= res.total_pages) break;
      pg++;
    }
    if (lastRes && allChapters.length > 0) {
      cacheAllChapters(bookId, {
        ...lastRes,
        items: allChapters,
        total: allChapters.length,
        page: 1,
        total_pages: 1,
      }).catch(() => {});
    }

    if (allChapters.length === 0) return;
    const total = allChapters.length;
    setDlProgress({ done: 0, total });
    let done = 0;
    for (const ch of allChapters) {
      try {
        const cached = await isChapterTextCached(ch.id);
        if (!cached) {
          const result = await api.getChapterText(ch.id);
          await cacheChapterText(ch.id, result.text_content);
        }
      } catch {
        // skip failed chapters
      }
      done++;
      setDlProgress({ done, total });
    }
    setDlDone(true);
    setDlProgress(null);
  }

  if (bookLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="w-8 h-8 text-accent" />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="text-center py-24">
        <svg
          className="w-16 h-16 mx-auto mb-4 text-text-faint"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
        <p className="text-text-mute font-medium">Không tìm thấy truyện</p>
        <Link
          href="/"
          className="text-sm text-accent hover:text-accent-dim mt-2 inline-block"
        >
          Quay lại thư viện
        </Link>
      </div>
    );
  }

  const chapters = chaptersData?.items ?? [];
  const firstChapter = chapters[0] ?? null;

  const listenResumeId =
    lastListenChapterId ?? bookProgress?.chapter_id ?? firstChapter?.id;
  const readResumeId = bookProgress?.chapter_id ?? firstChapter?.id;
  const hasProgress = !!bookProgress || !!lastListenChapterId;

  return (
    <div className="max-w-4xl mx-auto">
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
                className="flex items-center gap-3 px-4 py-3.5 rounded-md bg-accent hover:bg-accent-dim active:scale-[0.98] transition-all text-ink group shadow-[0_0_24px_var(--color-accent-glow)]"
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
                className="flex items-center gap-3 px-4 py-3.5 rounded-md bg-raised hover:bg-raised-hi active:scale-[0.98] transition-all text-text-dim group ring-1 ring-hairline"
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

            <button
              onClick={handleDownloadBook}
              disabled={!!dlProgress || dlDone}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium border transition-colors ${
                dlDone
                  ? "border-accent/40 text-accent bg-accent/10"
                  : dlProgress
                    ? "border-accent/40 text-accent bg-accent/10"
                    : "border-hairline text-text-mute hover:border-accent/40 hover:text-accent hover:bg-accent/10"
              }`}
            >
              {dlProgress ? (
                <>
                  <Spinner className="w-4 h-4" />
                  <span>
                    Đang tải... {dlProgress.done}/{dlProgress.total}
                  </span>
                </>
              ) : dlDone ? (
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
                  <span>Đã lưu offline</span>
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
          </div>
        ) : null}
      </div>

      {/* Chapter list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-xl text-text">Danh sách chương</h2>
          {chaptersData && (
            <span className="font-mono text-[10px] tracking-widest uppercase text-text-mute bg-raised border border-hairline-soft px-2.5 py-1 rounded-sm">
              {chaptersData.total} chương
            </span>
          )}
        </div>
        {chaptersLoading ? (
          <div className="flex justify-center py-12">
            <Spinner className="w-6 h-6 text-accent" />
          </div>
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
    </div>
  );
}
