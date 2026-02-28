"use client";
import { usePlayerContext } from "@/context/PlayerContext";

/**
 * Renders an invisible spacer at the bottom of the main content area
 * so content is never hidden behind the fixed MiniPlayer bar.
 */
export function PlayerPadding() {
  const { track } = usePlayerContext();
  return track ? <div className="h-17" /> : null;
}
