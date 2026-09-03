"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { usePlayerContext } from "@/context/PlayerContext";
import { isReaderRoute } from "@/lib/readerRoute";
import { Spinner } from "@/components/ui/Spinner";
import { IconButton } from "@/components/ui/Button";

export function MiniPlayer() {
  const { track, session, toggle } = usePlayerContext();
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
  if (!session.active) return null;

  const bookTitle = session.bookTitle;
  const coverUrl = session.coverUrl;
  const displayTitle = session.chapterTitle;
  const bookId = session.bookId;
  const displayChapterId = session.chapterId;
  const displayProgress = session.progress;
  const displayPlaying = session.isPlaying;
  const isBuffering = session.isBuffering;
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
          className={`h-full bg-accent transition-[width] duration-300 ${
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
          <div className="image-outline relative size-11 overflow-hidden rounded-lg bg-raised-hi">
            {coverUrl ? (
              <Image
                src={coverUrl}
                alt={bookTitle}
                width={44}
                height={44}
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

        <IconButton
          onClick={track?.onPrev ?? undefined}
          disabled={!track?.onPrev}
          label="Chương trước"
          className="text-text-faint disabled:opacity-25"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </svg>
        </IconButton>

        <IconButton
          onClick={toggle}
          label={displayPlaying ? "Tạm dừng" : "Phát"}
          tone="accent"
          className="relative shadow-[0_0_18px_var(--color-accent-glow)]"
        >
          {isBuffering ? (
            <Spinner className="w-4 h-4" />
          ) : (
            <span className="relative block size-4" aria-hidden="true">
              <svg
                className={`absolute inset-0 size-4 transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${displayPlaying ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"}`}
                fill="currentColor"
                viewBox="0 0 14 14"
              >
                <rect x="2" y="1" width="3.5" height="12" rx="0.5" />
                <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" />
              </svg>
              <svg
                className={`absolute inset-0 size-4 pl-0.5 transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${displayPlaying ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"}`}
                fill="currentColor"
                viewBox="0 0 14 14"
              >
                <path d="M3 1l10 6-10 6V1z" />
              </svg>
            </span>
          )}
        </IconButton>

        <IconButton
          onClick={track?.onNext ?? undefined}
          disabled={!track?.onNext}
          label="Chương tiếp"
          className="text-text-faint disabled:opacity-25"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}
