"use client";
import { useRef, useCallback, useEffect } from "react";
import { isLoggedIn } from "@/lib/auth";
import { api } from "@/lib/api";
import { enqueueProgress, saveLocalProgress } from "@/lib/progressQueue";

interface ProgressSyncOptions {
  bookId: string;
  chapterId: string;
  debounceMs?: number;
}

export function useProgressSync({
  bookId,
  chapterId,
  debounceMs = 5000,
}: ProgressSyncOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<number>(-1);
  const pendingRef = useRef<{ value: number; total?: number } | null>(null);

  const flush = useCallback(() => {
    if (!isLoggedIn() || !pendingRef.current) return;
    const { value, total } = pendingRef.current;
    if (value === lastSavedRef.current) return;

    lastSavedRef.current = value;
    pendingRef.current = null;

    saveLocalProgress({
      book_id: bookId,
      chapter_id: chapterId,
      progress_value: value,
      total_value: total,
    });

    api
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
