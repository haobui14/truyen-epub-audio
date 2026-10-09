"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

/**
 * Global app chrome (logo header + footer) — split out from layout.tsx so it
 * can react to pathname.
 *
 * The reader and the player are immersive screens and have their own top bars;
 * showing the global header on top of those steals viewport height on Android
 * (411×892) and pushes the play button below the fold. Hide both for those
 * routes.
 */
export function AppHeader() {
  const pathname = usePathname() ?? "";
  const immersive =
    pathname.startsWith("/listen") || pathname.startsWith("/read");
  if (immersive) return null;

  return (
    // Fixed rather than sticky: the Android WebView paints a ghost copy of a
    // position:sticky + backdrop-filter element while flinging back to the
    // top (the logo header showed up twice on every tab). The fixed bottom
    // bars never ghost, so position this one the same way; AppMain pads its
    // top to make up for the header no longer being in normal flow.
    <header
      className="fixed inset-x-0 bg-ink/85 backdrop-blur-md border-b border-hairline-soft z-40"
      style={{ top: "var(--sat)" }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <Image
            src="/brand/story-flame.svg"
            alt=""
            width={32}
            height={36}
            unoptimized
            className="h-9 w-8 shrink-0"
          />
          <span className="font-display text-lg tracking-tight text-text">
            Truyện
            <span className="italic text-accent ml-1">Audio</span>
          </span>
        </Link>
      </div>
    </header>
  );
}

export function AppMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const immersive =
    pathname.startsWith("/listen") || pathname.startsWith("/read");
  return (
    <main
      className={`flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 ${
        // pt-20 = the fixed header's h-14 plus the old py-6 breathing room.
        immersive ? "py-2" : "pt-20 pb-6"
      }`}
    >
      {children}
    </main>
  );
}

export function AppFooter() {
  const pathname = usePathname() ?? "";
  const immersive =
    pathname.startsWith("/listen") || pathname.startsWith("/read");
  if (immersive) return null;

  return (
    <footer className="hidden sm:block border-t border-hairline-soft bg-ink/50 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-text-faint">
        <p className="font-mono uppercase tracking-wider">
          &copy; {new Date().getFullYear()} TruyệnAudio
        </p>
        <div className="flex items-center gap-4">
          <a
            href="https://drive.google.com/uc?export=download&id=1Qoya_-FwGndr76XoOMVq9hfJBaDCTCeL"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-text-mute hover:text-accent transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Tải APK Android
          </a>
        </div>
      </div>
    </footer>
  );
}
