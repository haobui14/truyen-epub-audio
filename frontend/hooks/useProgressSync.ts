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
  /** Minimum gap between SERVER writes; device-local saves are not throttled. */
  serverIntervalMs?: number;
}

interface PendingServerWrite {
  book_id: string;
  chapter_id: string;
  chapter_index: number;
  progress_value: number;
  total_value?: number;
}

/**
 * The 5s debounce restarts on every report, so steady playback used to hit
 * the server once per chunk (~every 10–15s). Device-local saves still happen
 * on every debounced flush; the server row only matters across devices, so it
 * is written at most once per `serverIntervalMs`, with the latest position
 * always delivered: trailing write, plus an immediate one on chapter change,
 * unmount, page hide and unload.
 */
export function useProgressSync({
  bookId,
  chapterId,
  chapterIndex,
  debounceMs = 5000,
  serverIntervalMs = 30_000,
}: ProgressSyncOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<number>(-1);
  const pendingRef = useRef<{ value: number; total?: number } | null>(null);
  const chapterIndexRef = useRef(chapterIndex ?? -1);
  chapterIndexRef.current = chapterIndex ?? -1;

  const pendingServerRef = useRef<PendingServerWrite | null>(null);
  const serverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastServerWriteRef = useRef(0);

  const sendToServer = useCallback(() => {
    if (serverTimerRef.current) {
      clearTimeout(serverTimerRef.current);
      serverTimerRef.current = null;
    }
    const write = pendingServerRef.current;
    if (!write) return;
    pendingServerRef.current = null;
    lastServerWriteRef.current = Date.now();

    const { chapter_index: idx, ...body } = write;
    // Before sending to server, check if this chapter is still the latest
    // for the book. If native TTS advanced to a later chapter, skip the
    // server write to avoid overwriting newer progress.
    (idx >= 0 ? isLatestChapterForBook(body.book_id, idx) : Promise.resolve(true))
      .then((isLatest) => {
        if (!isLatest) return; // Stale chapter — skip server sync

        return api.saveProgress(body).catch(() => {
          lastSavedRef.current = -1;
          enqueueProgress(body);
        });
      })
      .catch(() => {});
  }, []);

  const flush = useCallback(
    (forceServer = false) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingRef.current;
      if (pending && pending.value !== lastSavedRef.current) {
        const { value, total } = pending;
        lastSavedRef.current = value;
        pendingRef.current = null;

        // Always save to local stores immediately — guests keep their position
        // on this device too, and syncBookProgressToServer pushes it up if they
        // sign in later.
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

        // The server row is account-only.
        if (isLoggedIn()) {
          pendingServerRef.current = {
            book_id: bookId,
            chapter_id: chapterId,
            chapter_index: chapterIndexRef.current,
            progress_value: value,
            total_value: total,
          };
        }
      }

      if (!pendingServerRef.current) return;
      const wait = lastServerWriteRef.current + serverIntervalMs - Date.now();
      if (forceServer || wait <= 0) {
        sendToServer();
      } else if (!serverTimerRef.current) {
        serverTimerRef.current = setTimeout(sendToServer, wait);
      }
    },
    [bookId, chapterId, serverIntervalMs, sendToServer],
  );

  const reportProgress = useCallback(
    (value: number, total?: number) => {
      pendingRef.current = { value, total };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flush(), debounceMs);
    },
    [flush, debounceMs],
  );

  useEffect(() => {
    const flushNow = () => flush(true);
    // pagehide/visibilitychange: mobile browsers often never fire
    // beforeunload when a backgrounded tab is discarded.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    window.addEventListener("beforeunload", flushNow);
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      // Runs on unmount AND on chapter change (flush is keyed on the
      // chapter), so the old chapter's last position goes out right away.
      flushNow();
      window.removeEventListener("beforeunload", flushNow);
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  const flushNow = useCallback(() => flush(true), [flush]);

  return { reportProgress, flush: flushNow };
}
