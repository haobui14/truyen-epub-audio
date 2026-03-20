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

  // On native, prefer the locally-cached data URL (works offline).
  // On web, fall back to the remote cover_url directly.
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

  // Fetch last-accessed chapter so buttons resume where user left off.
  // Falls back to local IndexedDB progress when offline.
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

  // Read + listen share one DB progress row (progress_type was removed).
  // The listen page saves its own last-chapter to localStorage so "Continue
  // Listening" resumes at the correct audio chapter even when reading got ahead.
  const lastListenChapterId = useMemo(
    () => localStorage.getItem(`listen-chapter:${bookId}`),
    [bookId],
  );

  async function handleDownloadBook() {
    if (dlProgress) return;
    setDlDone(false);

    // Cache book metadata so it's available offline
    if (book) cacheBook(book).catch(() => {});

    // Fetch and cache cover image as a base64 data URL for offline display
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
        // Cover caching is best-effort — skip on network error
      }
    }

    // Paginate through all chapters (Supabase caps at 1000 per query)
    const PAGE_SIZE = 1000;
    const allChapters: Chapter[] = [];
    let lastRes: Awaited<ReturnType<typeof api.getBookChapters>> | null = null;
    let pg = 1;
    while (true) {
      const res = await api.getBookChapters(bookId, pg, PAGE_SIZE);
      // Cache each page of chapters for offline browsing
      cacheChapters(bookId, pg, res).catch(() => {});
      allChapters.push(...res.items);
      lastRes = res;
      if (pg >= res.total_pages) break;
      pg++;
    }
    // Write a flat all-chapters snapshot so the listen page can load offline
    // without stitching pages together.
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
        <Spinner className="w-8 h-8 text-indigo-600" />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="text-center py-24">
        <svg
          className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600"
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
        <p className="text-gray-500 dark:text-gray-400 font-medium">
          Không tìm thấy truyện
        </p>
        <Link
          href="/"
          className="text-sm text-indigo-600 hover:text-indigo-700 mt-2 inline-block"
        >
          Quay lại thư viện
        </Link>
      </div>
    );
  }

  const chapters = chaptersData?.items ?? [];
  const firstChapter = chapters[0] ?? null;

  // Use localStorage-tracked listen chapter for audio resumption;
  // fall back to DB progress (which may be a read position), then first chapter.
  const listenResumeId =
    lastListenChapterId ?? bookProgress?.chapter_id ?? firstChapter?.id;
  const readResumeId = bookProgress?.chapter_id ?? firstChapter?.id;
  const hasProgress = !!bookProgress || !!lastListenChapterId;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 min-w-0">
          <Link
            href="/"
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors shrink-0"
          >
            Thư viện
          </Link>
          <svg
            className="w-3.5 h-3.5 shrink-0"
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
          <span className="text-gray-900 dark:text-gray-100 font-medium truncate max-w-xs">
            {book.title}
          </span>
        </div>
        {admin && (
          <Link
            href={`/admin/edit-book?id=${bookId}`}
            className="shrink-0 ml-3 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-300 dark:border-indigo-700 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
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
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden mb-6">
        <div className="flex gap-5 sm:gap-6 p-5 sm:p-6">
          <div className="w-28 sm:w-32 h-40 sm:h-44 rounded-xl overflow-hidden bg-linear-to-br from-indigo-50 to-purple-50 dark:from-indigo-950 dark:to-purple-950 shrink-0 shadow-md">
            {coverSrc ?? book.cover_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverSrc ?? book.cover_url!}
                alt={book.title}
                className="object-cover w-full h-full"
                onError={() => {
                  // If remote URL fails (offline), try the cached data URL
                  if (!coverSrc && book.cover_url) {
                    getCachedCover(bookId)
                      .then((c) => { if (c) setCoverSrc(c); })
                      .catch(() => {});
                  }
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-indigo-200 dark:text-indigo-800">
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
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1.5 leading-tight">
                {book.title}
              </h1>
              {book.author && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  {book.author}
                </p>
              )}
              {book.description && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 leading-relaxed line-clamp-3">
                  {book.description}
                </p>
              )}{" "}
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400 dark:text-gray-500 mb-3">
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
              {/* Genre tags */}
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
          <div className="flex items-center gap-3 mx-5 sm:mx-6 mb-5 sm:mb-6 px-4 py-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
            <Spinner className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Đang xử lý file EPUB...
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
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
                className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 active:scale-[0.98] transition-all text-white group"
              >
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0 group-hover:bg-white/30 transition-colors">
                  <svg
                    className="w-5 h-5 ml-0.5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm">
                    {hasProgress ? "Nghe tiếp" : "Nghe ngay"}
                  </p>
                  <p className="text-[11px] text-indigo-200 mt-0.5">
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
                className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 active:bg-gray-300 dark:active:bg-gray-500 active:scale-[0.98] transition-all text-gray-800 dark:text-gray-200 group"
              >
                <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center shrink-0 group-hover:bg-gray-300 dark:group-hover:bg-gray-500 transition-colors">
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
                  <p className="font-semibold text-sm">
                    {hasProgress ? "Đọc tiếp" : "Đọc truyện"}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {hasProgress ? "Tiếp tục từ chỗ dừng" : "Đọc văn bản"}
                  </p>
                </div>
              </Link>
            </div>

            {/* Download book offline */}
            <button
              onClick={handleDownloadBook}
              disabled={!!dlProgress || dlDone}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                dlDone
                  ? "border-emerald-300 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
                  : dlProgress
                    ? "border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30"
                    : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
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
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Danh sách chương
          </h2>
          {chaptersData && (
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2.5 py-1 rounded-full">
              {chaptersData.total} chương
            </span>
          )}
        </div>
        {chaptersLoading ? (
          <div className="flex justify-center py-12">
            <Spinner className="w-6 h-6 text-indigo-600" />
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
