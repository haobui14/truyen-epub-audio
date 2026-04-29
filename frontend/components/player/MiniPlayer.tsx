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
  const listenUrl = `/listen?id=${track.bookId}&chapter=${track.chapterId}`;

  return (
    <div
      className="fixed left-0 right-0 z-50 bg-raised/95 backdrop-blur-lg border-t border-hairline shadow-[0_-12px_32px_rgba(0,0,0,0.45)]"
      style={{ bottom: "calc(3.5rem + var(--sab))" }}
    >
      <div className="h-[2px] bg-hairline-soft">
        <div
          className="h-full bg-accent transition-all duration-300 shadow-[0_0_10px_var(--color-accent-glow)]"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
        <Link href={listenUrl} className="shrink-0">
          <div className="w-10 h-10 rounded-md overflow-hidden bg-raised-hi ring-1 ring-hairline">
            {book.cover_url ? (
              <Image
                src={book.cover_url}
                alt={book.title}
                width={40}
                height={40}
                className="object-cover w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-text-faint">
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

        <Link
          href={listenUrl}
          className="min-w-0 flex-1 flex items-center gap-2"
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] tracking-widest uppercase text-text-faint truncate leading-tight">
              {book.title}
            </p>
            <p className="text-sm font-medium text-text truncate leading-tight">
              {chapter.title}
            </p>
          </div>
          {isPlaying && !isBuffering && (
            <span className="flex items-end gap-0.5 text-accent shrink-0 h-4">
              <span className="sound-bar" />
              <span className="sound-bar" />
              <span className="sound-bar" />
            </span>
          )}
        </Link>

        <button
          onClick={track.onPrev ?? undefined}
          disabled={!track.onPrev}
          className="p-2 rounded-full text-text-faint hover:text-text disabled:opacity-25 transition-colors"
          title="Chương trước"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </svg>
        </button>

        <button
          onClick={toggle}
          className="w-10 h-10 bg-accent text-ink rounded-full flex items-center justify-center hover:bg-accent-dim active:scale-95 transition-all shadow-[0_0_18px_var(--color-accent-glow)]"
          title={isPlaying ? "Tạm dừng" : "Phát"}
        >
          {isBuffering ? (
            <Spinner className="w-4 h-4" />
          ) : isPlaying ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 14 14">
              <rect x="2" y="1" width="3.5" height="12" rx="0.5" />
              <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" />
            </svg>
          ) : (
            <svg
              className="w-4 h-4 ml-0.5"
              fill="currentColor"
              viewBox="0 0 14 14"
            >
              <path d="M3 1l10 6-10 6V1z" />
            </svg>
          )}
        </button>

        <button
          onClick={track.onNext ?? undefined}
          disabled={!track.onNext}
          className="p-2 rounded-full text-text-faint hover:text-text disabled:opacity-25 transition-colors"
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
