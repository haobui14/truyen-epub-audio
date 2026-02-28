"use client";
import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/constants";
import { isChapterCached, cacheChapterAudio } from "@/lib/audioFileCache";

export type CacheStatus = "uncached" | "downloading" | "cached";

/** Global set so duplicate hook instances don't double-download */
const inFlight = new Set<string>();

function dlKey(chapterId: string, voice: string) {
  return `${chapterId}:${voice}`;
}

/**
 * Silently downloads the full audio MP3 for each chapter into the browser's
 * Cache API so playback works offline.
 *
 * - One request per chapter (not per chunk).
 * - Downloads are concurrent.
 * - Waits for the `online` event if offline.
 * - Deduplicates across hook instances.
 *
 * @param chapters  Chapter IDs to cache (e.g. current ± 2)
 * @param voice     TTS voice key
 */
export function useChapterAudioPreload(
  chapters: { id: string }[],
  voice: string
) {
  const [statuses, setStatuses] = useState<Record<string, CacheStatus>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const key = chapters.map((c) => c.id).join(",");

  useEffect(() => {
    if (!chapters.length) return;

    for (const { id } of chapters) {
      const dk = dlKey(id, voice);
      if (inFlight.has(dk)) continue;

      (async () => {
        if (await isChapterCached(id, voice)) {
          if (mountedRef.current)
            setStatuses((prev) => ({ ...prev, [id]: "cached" }));
          return;
        }

        inFlight.add(dk);
        if (mountedRef.current)
          setStatuses((prev) => ({ ...prev, [id]: "downloading" }));

        try {
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            await new Promise<void>((resolve) =>
              window.addEventListener("online", () => resolve(), { once: true })
            );
          }

          const res = await fetch(
            `${API_URL}/api/tts/chapter-audio/${id}?voice=${encodeURIComponent(voice)}`
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          await cacheChapterAudio(id, voice, blob);

          if (mountedRef.current)
            setStatuses((prev) => ({ ...prev, [id]: "cached" }));
        } catch {
          if (mountedRef.current)
            setStatuses((prev) => ({ ...prev, [id]: "uncached" }));
        } finally {
          inFlight.delete(dk);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, voice]);

  return { cacheStatuses: statuses };
}

// ─── Legacy no-op exports kept for compatibility ──────────────────────────────
// (useSpeechPlayer no longer uses chapterBlobCache)
export const chapterBlobCache = new Map<never, never>();
