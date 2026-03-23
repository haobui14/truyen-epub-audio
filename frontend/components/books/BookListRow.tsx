import Link from "next/link";
import Image from "next/image";
import type { Book } from "@/types";
import { GenreTag } from "@/components/books/GenreManager";

const STORY_STATUS_LABELS: Record<string, { label: string; classes: string }> =
  {
    completed: {
      label: "Hoàn thành",
      classes:
        "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300",
    },
    ongoing: {
      label: "Đang ra",
      classes: "bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300",
    },
    unknown: {
      label: "Chưa rõ",
      classes: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400",
    },
  };

export function BookListRow({ book }: { book: Book }) {
  const storyStatus =
    STORY_STATUS_LABELS[book.story_status ?? "unknown"] ??
    STORY_STATUS_LABELS.unknown;

  return (
    <Link
      href={`/book?id=${book.id}`}
      className="flex items-start gap-3 sm:gap-4 bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700/60 hover:border-indigo-200 dark:hover:border-indigo-800/60 shadow-sm hover:shadow-md active:scale-[0.99] transition-all duration-200 p-3 group"
    >
      {/* Cover thumbnail */}
      <div className="flex-none w-14 sm:w-16 aspect-2/3 rounded-xl overflow-hidden bg-linear-to-br from-indigo-50 to-purple-50 dark:from-indigo-950 dark:to-purple-950 relative shadow-sm">
        {book.cover_url ? (
          <Image
            src={book.cover_url}
            alt={book.title}
            fill
            sizes="64px"
            className="object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg
              className="w-6 h-6 text-indigo-300 dark:text-indigo-700"
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

      {/* Content */}
      <div className="flex-1 min-w-0 py-0.5">
        {/* Title */}
        <h3
          className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-snug line-clamp-2 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors mb-0.5"
          title={book.title}
        >
          {book.title}
        </h3>

        {/* Author */}
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate mb-2">
          {book.author ?? "—"}
        </p>

        {/* Bottom row: badges + chapter count */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Story status badge */}
          <span
            className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${storyStatus.classes}`}
          >
            {storyStatus.label}
          </span>

          {/* Genre tags */}
          {book.genres && book.genres.length > 0 && (
            <>
              {book.genres.slice(0, 2).map((g) => (
                <GenreTag key={g.id} genre={g} />
              ))}
              {book.genres.length > 2 && (
                <span className="text-[10px] text-gray-400 dark:text-gray-500">
                  +{book.genres.length - 2}
                </span>
              )}
            </>
          )}

          {/* Chapter count */}
          <span className="ml-auto flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 flex-none">
            <svg
              className="w-3 h-3"
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
            {book.total_chapters}
          </span>
        </div>
      </div>

      {/* Chevron */}
      <div className="flex-none self-center text-gray-300 dark:text-gray-600 group-hover:text-indigo-400 transition-colors">
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
            d="M9 5l7 7-7 7"
          />
        </svg>
      </div>
    </Link>
  );
}
