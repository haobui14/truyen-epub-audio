"use client";
import Link from "next/link";
import Image from "next/image";
import { usePlayerContext } from "@/context/PlayerContext";
import { Spinner } from "@/components/ui/Spinner";

export function MiniPlayer() {
  const { track, isPlaying, isBuffering, progress, toggle } =
    usePlayerContext();

  if (!track) return null;

  const { book, chapter } = track;
  const progressPct = Math.round(progress * 100);
  const listenUrl = `/books/${track.bookId}/listen?chapter=${track.chapterId}`;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border-t border-gray-200 dark:border-gray-800 shadow-lg">
      {/* Thin progress bar along the very top edge */}
      <div className="h-0.5 bg-gray-100 dark:bg-gray-800">
        <div
          className="h-full bg-indigo-500 transition-all duration-300"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
        {/* Cover → tap to go to listen page */}
        <Link href={listenUrl} className="shrink-0">
          <div className="w-10 h-10 rounded-lg overflow-hidden bg-indigo-100 dark:bg-indigo-950 shadow-sm">
            {book.cover_url ? (
              <Image
                src={book.cover_url}
                alt={book.title}
                width={40}
                height={40}
                className="object-cover w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-indigo-300">
                <svg
                  className="w-5 h-5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                </svg>
              </div>
            )}
          </div>
        </Link>

        {/* Track info → tap to go to listen page */}
        <Link href={listenUrl} className="min-w-0 flex-1">
          <p className="text-xs text-indigo-500 dark:text-indigo-400 truncate leading-tight">
            {book.title}
          </p>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate leading-tight">
            {chapter.title}
          </p>
        </Link>

        {/* Prev chapter */}
        <button
          onClick={track.onPrev ?? undefined}
          disabled={!track.onPrev}
          className="p-2 rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-25 transition-all"
          title="Chương trước"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </svg>
        </button>

        {/* Play / Pause */}
        <button
          onClick={toggle}
          className="w-10 h-10 bg-indigo-600 text-white rounded-full flex items-center justify-center hover:bg-indigo-700 active:scale-95 transition-all shadow-sm"
          title={isPlaying ? "Tạm dừng" : "Phát"}
        >
          {isBuffering ? (
            <Spinner className="w-4 h-4" />
          ) : isPlaying ? (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg
              className="w-5 h-5 ml-0.5"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Next chapter */}
        <button
          onClick={track.onNext ?? undefined}
          disabled={!track.onNext}
          className="p-2 rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-25 transition-all"
          title="Chương tiếp"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
