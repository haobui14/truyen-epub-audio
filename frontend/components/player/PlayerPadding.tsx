"use client";
import { usePathname } from "next/navigation";
import { usePlayerContext } from "@/context/PlayerContext";
import { isReaderRoute } from "@/lib/readerRoute";

/**
 * Renders an invisible spacer at the bottom of the main content area
 * to prevent content from being hidden behind the fixed MiniPlayer and
 * the fixed bottom navigation bar.
 */
export function PlayerPadding() {
  const { track } = usePlayerContext();
  const pathname = usePathname();

  // The reader hides the tab bar and sets its own bottom padding, so this
  // spacer would only add a dead gap at the end of every chapter.
  if (isReaderRoute(pathname)) return null;

  // Nav bar (3.5rem) + safe-area-inset-bottom is always present.
  // Add MiniPlayer height (~4.25rem) on top when the player is active.
  const navH = "calc(3.5rem + var(--sab))";
  if (!track) return <div style={{ height: navH }} />;
  return <div style={{ height: "calc(7.75rem + var(--sab))" }} />;
}
