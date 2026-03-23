"use client";
import Link from "next/link";
import Image from "next/image";
import type { Book } from "@/types";
import { GenreTag } from "@/components/books/GenreManager";

export function SpotlightCard({ book }: { book: Book }) {
  return (
    <Link
      href={`/book?id=${book.id}`}
      className="group relative flex overflow-hidden rounded-2xl bg-gray-900 shadow-lg hover:shadow-xl transition-shadow duration-300"
    >
      {/* Blurred background from cover */}
      {book.cover_url && (
        <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
          <Image
            src={book.cover_url}
            alt=""
            fill
            className="object-cover blur-2xl scale-110 opacity-20"
            sizes="100vw"
            priority
          />
        </div>
      )}
      {/* Gradient overlays */}
      <div className="absolute inset-0 bg-linear-to-r from-gray-900/95 via-gray-900/80 to-gray-900/30" />
      <div className="absolute inset-0 bg-linear-to-t from-gray-900/70 via-transparent to-transparent sm:hidden" />

      {/* Cover image */}
      <div className="relative flex-none w-28 sm:w-44 md:w-52 aspect-2/3 overflow-hidden">
        {book.cover_url ? (
          <Image
            src={book.cover_url}
            alt={book.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            sizes="(max-width: 640px) 112px, (max-width: 768px) 176px, 208px"
            priority
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-indigo-900/50">
            <svg
              className="w-12 h-12 text-indigo-500/40"
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
      <div className="relative flex flex-col justify-center px-5 py-5 sm:px-8 sm:py-7 flex-1 min-w-0">
        {/* "Nổi bật" badge */}
        <span className="inline-flex items-center gap-1.5 text-[10px] sm:text-xs font-semibold uppercase tracking-widest text-indigo-400 mb-2 sm:mb-3">
          <svg className="w-3 h-3 flex-none" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          {book.featured_label ?? "Nổi bật"}
        </span>

        {/* Title */}
        <h2 className="text-lg sm:text-2xl md:text-3xl font-bold text-white leading-tight line-clamp-2 mb-1">
          {book.title}
        </h2>

        {/* Author */}
        {book.author && (
          <p className="text-xs sm:text-sm text-gray-400 mb-2 sm:mb-3 truncate">
            {book.author}
          </p>
        )}

        {/* Description — hidden on mobile to save space */}
        {book.description && (
          <p className="hidden sm:block text-sm text-gray-400 leading-relaxed line-clamp-2 mb-4">
            {book.description}
          </p>
        )}

        {/* Genre tags — hidden on mobile */}
        {book.genres && book.genres.length > 0 && (
          <div className="hidden sm:flex flex-wrap gap-1.5 mb-4">
            {book.genres.slice(0, 4).map((g) => (
              <GenreTag key={g.id} genre={g} />
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 mt-auto pt-2 sm:pt-0">
          <span className="inline-flex items-center gap-1.5 bg-indigo-600 group-hover:bg-indigo-500 text-white text-xs sm:text-sm font-semibold px-3.5 py-2 rounded-xl shadow-md transition-colors">
            <svg
              className="w-3.5 h-3.5 sm:w-4 sm:h-4 flex-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Nghe ngay
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <svg
              className="w-3.5 h-3.5 flex-none"
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
        </div>
      </div>
    </Link>
  );
}
