"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { BookGrid } from "@/components/books/BookGrid";
import { Spinner } from "@/components/ui/Spinner";

export default function HomePage() {
  const { data: books, isLoading, error } = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    refetchInterval: 10_000,
  });

  const hasBooks = books && books.length > 0;

  return (
    <div>
      {/* Hero / welcome section */}
      {!hasBooks && !isLoading && !error && (
        <div className="text-center py-16 sm:py-24">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-950 dark:to-purple-950 rounded-2xl mb-6">
            <svg className="w-10 h-10 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100 mb-3">Chào mừng đến TruyệnAudio</h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto mb-8">
            Tải lên file EPUB để nghe hoặc đọc truyện tiếng Việt với giọng đọc AI tự nhiên.
          </p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-2 bg-indigo-600 text-white font-medium px-6 py-3 rounded-xl hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-md hover:shadow-lg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Tải lên truyện đầu tiên
          </Link>
        </div>
      )}

      {/* Library header */}
      {(hasBooks || isLoading) && (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Thư viện truyện</h1>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">Nghe hoặc đọc truyện của bạn</p>
          </div>
          {books && (
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1.5 rounded-full">
              {books.length} truyện
            </span>
          )}
        </div>
      )}

      {isLoading && (
        <div className="flex flex-col items-center gap-3 py-24">
          <Spinner className="w-8 h-8 text-indigo-600" />
          <p className="text-sm text-gray-400">Đang tải thư viện...</p>
        </div>
      )}

      {error && (
        <div className="text-center py-24">
          <svg className="w-12 h-12 mx-auto mb-3 text-red-300 dark:text-red-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <p className="text-red-500 font-medium">Không thể tải danh sách truyện</p>
          <p className="text-sm text-gray-400 mt-1">Vui lòng kiểm tra kết nối và thử lại.</p>
        </div>
      )}

      {hasBooks && <BookGrid books={books} />}
    </div>
  );
}
