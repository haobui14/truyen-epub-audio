"use client";
import { useRef, useCallback, useEffect } from "react";
import { isLoggedIn } from "@/lib/auth";
import { api } from "@/lib/api";
import {
  enqueueProgress,
  saveLocalProgress,
  saveLocalBookProgress,
  isLatestChapterForBook,
} from "@/lib/progressQueue";

interface ProgressSyncOptions {
  bookId: string;
  chapterId: string;
  chapterIndex?: number;
  debounceMs?: number;
}

export function useProgressSync({
  bookId,
  chapterId,
  chapterIndex,
  debounceMs = 5000,
}: ProgressSyncOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<number>(-1);
  const pendingRef = useRef<{ value: number; total?: number } | null>(null);
  const chapterIndexRef = useRef(chapterIndex ?? -1);
  chapterIndexRef.current = chapterIndex ?? -1;

  const flush = useCallback(() => {
    if (!isLoggedIn() || !pendingRef.current) return;
    const { value, total } = pendingRef.current;
    if (value === lastSavedRef.current) return;

    lastSavedRef.current = value;
    pendingRef.current = null;

    // Always save to local stores immediately
    saveLocalProgress({
      book_id: bookId,
      chapter_id: chapterId,
      progress_value: value,
      total_value: total,
    });

    // Save book-level progress (only advances, never goes backward)
    if (chapterIndexRef.current >= 0) {
      saveLocalBookProgress({
        book_id: bookId,
        chapter_id: chapterId,
        chapter_index: chapterIndexRef.current,
        progress_value: value,
        total_value: total,
      });
    }

    // Before sending to server, check if this chapter is still the latest
    // for the book. If native TTS advanced to a later chapter, skip the
    // server write to avoid overwriting newer progress.
    const idx = chapterIndexRef.current;
    (idx >= 0 ? isLatestChapterForBook(bookId, idx) : Promise.resolve(true))
      .then((isLatest) => {
        if (!isLatest) return; // Stale chapter — skip server sync

        return api
          .saveProgress({
            book_id: bookId,
            chapter_id: chapterId,
            progress_value: value,
            total_value: total,
          })
          .catch(() => {
            lastSavedRef.current = -1;
            enqueueProgress({
              book_id: bookId,
              chapter_id: chapterId,
              progress_value: value,
              total_value: total,
            });
          });
      })
      .catch(() => {});
  }, [bookId, chapterId]);

  const reportProgress = useCallback(
    (value: number, total?: number) => {
      if (!isLoggedIn()) return;
      pendingRef.current = { value, total };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, debounceMs);
    },
    [flush, debounceMs],
  );

  useEffect(() => {
    const handleUnload = () => flush();
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      flush();
      window.removeEventListener("beforeunload", handleUnload);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [flush]);

  return { reportProgress, flush };
}
