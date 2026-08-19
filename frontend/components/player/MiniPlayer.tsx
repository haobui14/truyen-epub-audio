"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { usePlayerContext } from "@/context/PlayerContext";
import { isReaderRoute } from "@/lib/readerRoute";
import { Spinner } from "@/components/ui/Spinner";

export function MiniPlayer() {
  const { track, isPlaying, isBuffering, progress, toggle, nativeChapterOverride } =
    usePlayerContext();
  const pathname = usePathname();
  // While reading, this bar is competing with the text: it drops the heavy
  // drop-shadow and the glowing progress line, gets shorter, and sits above
  // the reader's own chapter bar (the tab bar it normally clears is hidden
  // there, so the usual 3.5rem offset would leave it floating).
  const reading = isReaderRoute(pathname);

  // Render even with NO track when the native service holds a session — a
  // cold start lands on the home page with audio possibly still playing (or a
  // restored session sitting paused); without this there would be zero UI for
  // it. Requires the override's bookId so the link can navigate somewhere.
  if (!track && !nativeChapterOverride?.bookId) return null;

  // While native auto-advances in the background, the track (set by the listen
  // page) goes stale — prefer the live native session info when it differs.
  const bookTitle = nativeChapterOverride?.bookTitle || track?.book.title || "";
  const coverUrl = nativeChapterOverride?.coverUrl || track?.book.cover_url || null;
  const displayTitle = nativeChapterOverride?.title || track?.chapter.title || "";
  const bookId = nativeChapterOverride?.bookId || track?.bookId || "";
  const displayChapterId =
    nativeChapterOverride?.chapterId ?? track?.chapterId ?? "";
  const displayProgress =
    nativeChapterOverride && nativeChapterOverride.totalChunks > 0
      ? nativeChapterOverride.chunkIndex / nativeChapterOverride.totalChunks
      : progress;
  const displayPlaying = nativeChapterOverride
    ? nativeChapterOverride.playing
    : isPlaying;
  const progressPct = Math.round(
    Math.max(0, Math.min(1, displayProgress)) * 100,
  );
  const listenUrl = `/listen?id=${bookId}&chapter=${displayChapterId}`;

  return (
    <div
      className={`fixed left-0 right-0 z-50 bg-raised/95 backdrop-blur-lg border-t border-hairline ${
        reading ? "shadow-none" : "shadow-[0_-12px_32px_rgba(0,0,0,0.45)]"
      }`}
      style={{
        bottom: reading
          ? "calc(4.25rem + var(--sab))"
          : "calc(3.5rem + var(--sab))",
      }}
    >
      <div className="h-[2px] bg-hairline-soft">
        <div
          className={`h-full bg-accent transition-all duration-300 ${
            reading ? "" : "shadow-[0_0_10px_var(--color-accent-glow)]"
          }`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div
        className={`max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-3 ${
          reading ? "h-12" : "h-16"
        }`}
      >
        <Link href={listenUrl} className="shrink-0">
          <div className="w-10 h-10 rounded-md overflow-hidden bg-raised-hi ring-1 ring-hairline">
            {coverUrl ? (
              <Image
                src={coverUrl}
                alt={bookTitle}
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
              {bookTitle}
            </p>
            <p className="text-sm font-medium text-text truncate leading-tight">
              {displayTitle}
            </p>
          </div>
          {displayPlaying && !isBuffering && (
            <span className="flex items-end gap-0.5 text-accent shrink-0 h-4">
              <span className="sound-bar" />
              <span className="sound-bar" />
              <span className="sound-bar" />
            </span>
          )}
        </Link>

        <button
          onClick={track?.onPrev ?? undefined}
          disabled={!track?.onPrev}
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
          title={displayPlaying ? "Tạm dừng" : "Phát"}
        >
          {isBuffering ? (
            <Spinner className="w-4 h-4" />
          ) : displayPlaying ? (
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
          onClick={track?.onNext ?? undefined}
          disabled={!track?.onNext}
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
