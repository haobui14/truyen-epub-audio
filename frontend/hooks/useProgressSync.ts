"use client";
import { useRef, useCallback, useEffect } from "react";
import { isLoggedIn } from "@/lib/auth";
import { api } from "@/lib/api";

interface ProgressSyncOptions {
  bookId: string;
  chapterId: string;
  progressType: "read" | "listen";
  debounceMs?: number;
}

export function useProgressSync({
  bookId,
  chapterId,
  progressType,
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

    api
      .saveProgress({
        book_id: bookId,
        chapter_id: chapterId,
        progress_type: progressType,
        progress_value: value,
        total_value: total,
      })
      .catch(() => {
        // Silent fail — localStorage is still the fallback
        lastSavedRef.current = -1;
      });
  }, [bookId, chapterId, progressType]);

  const reportProgress = useCallback(
    (value: number, total?: number) => {
      if (!isLoggedIn()) return;
      pendingRef.current = { value, total };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, debounceMs);
    },
    [flush, debounceMs],
  );

  // Flush on unmount and page unload
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
