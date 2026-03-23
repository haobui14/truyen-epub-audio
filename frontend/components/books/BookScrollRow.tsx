import Link from "next/link";
import Image from "next/image";
import type { Book } from "@/types";

interface Props {
  title: string;
  seeAllHref?: string;
  /** Tailwind bg-* class for the colored dot in the section header, e.g. "bg-indigo-500" */
  colorDot?: string;
  books: Book[];
}

export function BookScrollRow({ title, seeAllHref, colorDot, books }: Props) {
  if (books.length === 0) return null;

  return (
    <section className="mb-8">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {colorDot && (
            <span className={`w-2.5 h-2.5 rounded-full ${colorDot} shrink-0`} />
          )}
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
        </div>
        {seeAllHref && (
          <Link
            href={seeAllHref}
            className="flex items-center gap-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
          >
            Xem thêm
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </Link>
        )}
      </div>

      {/* Horizontal scroll list */}
      <div className="flex gap-3 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] pb-1">
        {books.map((book) => (
          <Link
            key={book.id}
            href={`/book?id=${book.id}`}
            className="flex-none w-28 sm:w-33 group"
          >
            {/* Cover */}
            <div className="aspect-2/3 rounded-xl overflow-hidden bg-linear-to-br from-indigo-50 to-purple-50 dark:from-indigo-950 dark:to-purple-950 relative shadow-sm mb-2">
              {book.cover_url ? (
                <Image
                  src={book.cover_url}
                  alt={book.title}
                  fill
                  sizes="132px"
                  className="object-cover group-hover:scale-105 transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg
                    className="w-8 h-8 text-indigo-300 dark:text-indigo-700"
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

            {/* Title */}
            <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 line-clamp-2 leading-tight group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              {book.title}
            </p>

            {/* Author */}
            {book.author && (
              <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate mt-0.5">
                {book.author}
              </p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
