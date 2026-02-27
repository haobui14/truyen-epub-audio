"use client";
import Link from "next/link";
import type { Chapter } from "@/types";

function ChapterRow({
  chapter,
  bookId,
}: {
  chapter: Chapter;
  bookId: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3 px-4 border-b border-gray-100 dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
      <span className="text-xs font-mono text-gray-400 dark:text-gray-500 w-8 shrink-0 text-right">
        {chapter.chapter_index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{chapter.title}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{chapter.word_count.toLocaleString()} từ</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Link
          href={`/books/${bookId}/read?chapter=${chapter.id}`}
          className="p-1.5 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 bg-gray-100 dark:bg-gray-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 rounded-lg transition-colors"
          title="Đọc"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
        </Link>
        <Link
          href={`/books/${bookId}/listen?chapter=${chapter.id}`}
          className="p-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          title="Nghe"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

function PaginationButton({
  page,
  currentPage,
  onClick,
}: {
  page: number;
  currentPage: number;
  onClick: (p: number) => void;
}) {
  const isActive = page === currentPage;
  return (
    <button
      onClick={() => onClick(page)}
      className={`min-w-[36px] h-9 px-2 text-sm font-medium rounded-lg transition-colors ${
        isActive
          ? "bg-indigo-600 text-white shadow-sm"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
      }`}
    >
      {page}
    </button>
  );
}

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;

  // Build page numbers to show: always show first, last, current, and neighbors
  const pages: (number | "ellipsis")[] = [];
  const addPage = (p: number) => {
    if (p >= 1 && p <= totalPages && !pages.includes(p)) {
      pages.push(p);
    }
  };

  addPage(1);
  if (page > 3) pages.push("ellipsis");
  for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) {
    addPage(i);
  }
  if (page < totalPages - 2) pages.push("ellipsis");
  addPage(totalPages);

  return (
    <div className="flex items-center justify-center gap-1 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="h-9 px-3 text-sm font-medium rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span key={`ellipsis-${i}`} className="px-1 text-gray-400 dark:text-gray-500 text-sm">
            …
          </span>
        ) : (
          <PaginationButton key={p} page={p} currentPage={page} onClick={onPageChange} />
        )
      )}

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="h-9 px-3 text-sm font-medium rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

export function ChapterList({
  chapters,
  bookId,
  page,
  totalPages,
  total,
  onPageChange,
}: {
  chapters: Chapter[];
  bookId: string;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (chapters.length === 0 && page === 1) {
    return (
      <div className="text-center py-12 text-gray-400 dark:text-gray-500 text-sm">
        Đang phân tích chương...
      </div>
    );
  }

  return (
    <div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm divide-y divide-gray-100 dark:divide-gray-700">
        {chapters.map((ch) => (
          <ChapterRow key={ch.id} chapter={ch} bookId={bookId} />
        ))}
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </div>
  );
}
