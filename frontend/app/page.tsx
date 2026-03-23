"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getCachedBooks, cacheBooks } from "@/lib/bookCache";
import { isAdmin } from "@/lib/auth";
import { BookGrid } from "@/components/books/BookGrid";
import { SpotlightCard } from "@/components/books/SpotlightCard";
import { Spinner } from "@/components/ui/Spinner";

export default function HomePage() {
  const admin = useSyncExternalStore(
    (cb) => {
      window.addEventListener("auth-change", cb);
      return () => window.removeEventListener("auth-change", cb);
    },
    isAdmin,
    () => false,
  );

  const {
    data: books,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["books"],
    queryFn: async () => {
      try {
        const data = await api.listBooks();
        cacheBooks(data).catch(() => {});
        return data;
      } catch {
        const cached = await getCachedBooks();
        if (cached) return cached;
        throw new Error("offline");
      }
    },
    refetchInterval: 10_000,
  });

  const hasBooks = books && books.length > 0;
  const featuredBook = books?.find((b) => b.is_featured) ?? books?.[0] ?? null;

  return (
    <div>
      {/* Empty-state hero */}
      {!hasBooks && !isLoading && !error && (
        <div className="text-center py-20 sm:py-28">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-linear-to-br from-indigo-100 to-purple-100 dark:from-indigo-950 dark:to-purple-950 rounded-2xl mb-6 shadow-inner animate-float">
            <svg
              className="w-10 h-10 text-indigo-500"
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
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100 mb-3">
            Chào mừng đến TruyệnAudio
          </h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto mb-8 text-base leading-relaxed">
            Tải lên file EPUB để nghe hoặc đọc truyện tiếng Việt với giọng đọc
            AI tự nhiên.
          </p>
          {admin && (
            <Link
              href="/upload"
              className="inline-flex items-center gap-2 bg-indigo-600 text-white font-medium px-6 py-3 rounded-xl hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-md hover:shadow-lg"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Tải lên truyện đầu tiên
            </Link>
          )}
        </div>
      )}

      {/* Library section */}
      {(hasBooks || isLoading) && (
        <>
          {/* Spotlight — featured book hero */}
          {hasBooks && featuredBook && (
            <div className="mb-7">
              <SpotlightCard book={featuredBook} />
            </div>
          )}

          {/* Header row */}
          <div className="flex items-center justify-between mb-5">
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 leading-tight">
                Thư viện truyện
              </h1>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                Nghe hoặc đọc truyện của bạn
              </p>
            </div>
            {books && (
              <div className="flex items-center gap-2">
                {/* Search shortcut */}
                <Link
                  href="/search"
                  className="p-2 rounded-xl text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                  title="Tìm kiếm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </Link>
                {admin && (
                  <Link
                    href="/admin/manage-books"
                    className="p-2 rounded-xl text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                    title="Quản lý truyện"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </Link>
                )}
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1.5 rounded-full tabular-nums">
                  {books.length} truyện
                </span>
              </div>
            )}
          </div>
        </>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex flex-col items-center gap-3 py-24">
          <Spinner className="w-8 h-8 text-indigo-600" />
          <p className="text-sm text-gray-400">Đang tải thư viện...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-24">
          <svg
            className="w-12 h-12 mx-auto mb-3 text-red-300 dark:text-red-800"
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
          <p className="text-red-500 font-medium">
            Không thể tải danh sách truyện
          </p>
          <p className="text-sm text-gray-400 mt-1">
            Vui lòng kiểm tra kết nối và thử lại.
          </p>
        </div>
      )}

      {/* Book grid */}
      {hasBooks && <BookGrid books={books} />}
    </div>
  );
}
