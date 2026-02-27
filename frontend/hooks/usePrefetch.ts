"use client";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";

const PREFETCH_AHEAD = 3;

/**
 * When the current chapter index changes, automatically prefetch
 * the next PREFETCH_AHEAD chapters so they're ready before the user
 * needs them.
 */
export function usePrefetch(
  bookId: string | null,
  currentChapterIndex: number | null
) {
  const lastPrefetchedRef = useRef<number>(-1);

  useEffect(() => {
    if (!bookId || currentChapterIndex === null) return;

    // Only prefetch when we've moved to a new chapter
    if (currentChapterIndex <= lastPrefetchedRef.current) return;

    const fromIndex = currentChapterIndex + 1;
    lastPrefetchedRef.current = currentChapterIndex;

    api.prefetchChapters(bookId, fromIndex, PREFETCH_AHEAD).catch(() => {
      // Silently ignore — prefetch is best-effort
    });
  }, [bookId, currentChapterIndex]);
}
