"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from "@/lib/constants";
import { getCachedAudioUrl } from "@/lib/audioFileCache";
import { splitIntoChunks } from "@/lib/textChunks";

// ── Cross-chapter prefetch cache ──────────────────────────────────────
// Persists across chapter resets so pre-fetched audio for the NEXT chapter
// survives the cleanup that happens when chapterId changes.
const crossChapterCache = new Map<string, Promise<string>>();
const crossChapterAbort = { ctrl: null as AbortController | null };

function ccKey(chapterId: string, idx: number, voice: string) {
  return `${chapterId}:${idx}:${voice}`;
}

/**
 * Pre-fetch the first few TTS audio chunks for the next chapter.
 * Call this while the current chapter is still playing (near the end)
 * so playback can start instantly on auto-advance.
 */
export function prefetchNextChapterAudio(
  chapterId: string,
  text: string,
  voice: string,
) {
  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) return;
  // Reuse existing controller or create new one
  if (!crossChapterAbort.ctrl) crossChapterAbort.ctrl = new AbortController();
  const signal = crossChapterAbort.ctrl.signal;
  for (let i = 0; i < Math.min(3, chunks.length); i++) {
    const key = ccKey(chapterId, i, voice);
    if (!crossChapterCache.has(key)) {
      const p = fetchChunkAudio(chunks[i], voice, signal);
      p.catch(() => {}); // suppress unhandled rejection
      crossChapterCache.set(key, p);
    }
  }
}

/** Wait until the browser has a network connection. */
function waitForOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine)
    return Promise.resolve();
  return new Promise((resolve) =>
    window.addEventListener("online", () => resolve(), { once: true }),
  );
}

/**
 * POST text + voice to backend, return a blob URL.
 * - Retries on network errors and 5xx (back-off 2s).
 * - Does NOT retry on 4xx (client errors — retrying won't help).
 * - Each individual request times out after 20s; a timeout triggers a retry.
 * - Respects the chapter/voice AbortSignal for cancellation.
 */
async function fetchChunkAudio(
  text: string,
  voice: string,
  signal: AbortSignal,
): Promise<string> {
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await waitForOnline();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Per-request timeout controller linked to the chapter/voice signal
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 20_000);
    const onParentAbort = () => ctrl.abort();
    signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(`${API_URL}/api/tts/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
        signal: ctrl.signal,
      });
      if (res.status >= 400 && res.status < 500) {
        // Client error — retrying won't help; stop the player
        throw new Error(`TTS_CLIENT_ERROR_${res.status}`);
      }
      if (!res.ok) throw new Error(`TTS error ${res.status}`); // 5xx → retry
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      const name = (err as Error).name;
      const msg = (err as Error).message ?? "";
      if (name === "AbortError") {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError"); // chapter/voice changed
        // else: 20s timeout — fall through to retry
      } else if (msg.startsWith("TTS_CLIENT_ERROR_")) {
        throw err; // 4xx — propagate, don't retry
      }
      // Network / 5xx / timeout — back off then retry
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onParentAbort);
    }
  }
}

export function useSpeechPlayer(
  bookId: string,
  chapterId: string,
  text: string | null | undefined,
  voiceName: string | null,
  onEnded?: (nativeChapterId?: string) => void,
  autoPlay?: boolean,
  initialChunkIndex?: number,
) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [rate, setRateState] = useState(1);

  // "full" = playing cached single blob; "streaming" = chunk-by-chunk
  const modeRef = useRef<"streaming" | "full">("streaming");
  const fullBlobUrlRef = useRef<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<string[]>([]);
  const prefetchRef = useRef<Map<number, Promise<string>>>(new Map());
  // All blob URLs created for streaming chunks — tracked so we can revoke them
  const blobUrlsRef = useRef<string[]>([]);
  const chunkRef = useRef(0);
  const stoppedRef = useRef(true);
  const rateRef = useRef(1);
  const voiceRef = useRef(voiceName ?? "vi-VN-HoaiMyNeural");
  voiceRef.current = voiceName ?? "vi-VN-HoaiMyNeural";
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // Guard: set stoppedRef synchronously during render when chapterId changes,
  // BEFORE any effects or audio event callbacks run. This closes the race window
  // where the old chapter's audio fires `onended` after onEndedRef has already
  // been updated to the new chapter's callback (which would skip ahead).
  const prevChapterIdRef = useRef(chapterId);
  if (prevChapterIdRef.current !== chapterId) {
    prevChapterIdRef.current = chapterId;
    stoppedRef.current = true;
  }
  const initialChunkRef = useRef(initialChunkIndex ?? 0);
  initialChunkRef.current = initialChunkIndex ?? 0;

  // AbortController — cancelled when chapter/voice changes to stop stale fetches
  const abortRef = useRef<AbortController | null>(null);

  // Track online/offline to surface in UI
  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => setIsOffline(false);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // Create audio element once
  useEffect(() => {
    if (typeof window === "undefined") return;
    audioRef.current = new Audio();
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const prefetch = useCallback((index: number) => {
    if (index < 0 || index >= chunksRef.current.length) return;
    if (!prefetchRef.current.has(index)) {
      const signal = abortRef.current?.signal ?? new AbortController().signal;
      const promise = fetchChunkAudio(
        chunksRef.current[index],
        voiceRef.current,
        signal,
      ).then((url) => {
        blobUrlsRef.current.push(url); // track for revocation
        return url;
      });
      // Suppress AbortError so the unfullfilled prefetch never becomes an
      // unhandled promise rejection when we intentionally cancel() it.
      promise.catch((err) => {
        if ((err as Error).name !== "AbortError") console.error(err);
      });
      prefetchRef.current.set(index, promise);
    }
  }, []);

  /** Set up the audio element handlers for full-audio mode. */
  const setupFullAudio = useCallback(
    (audio: HTMLAudioElement, blobUrl: string, startPlay: boolean) => {
      modeRef.current = "full";
      audio.src = blobUrl;
      audio.playbackRate = rateRef.current;

      const updateProgress = () => {
        if (!audio.duration) return;
        setChunkIndex(Math.floor(audio.currentTime));
        setTotalChunks(Math.floor(audio.duration));
      };
      audio.ontimeupdate = updateProgress;
      audio.onloadedmetadata = () => {
        // Seek to saved position on manual navigation (not autoplay)
        if (!startPlay && initialChunkRef.current > 0 && audio.duration > 0) {
          audio.currentTime = Math.min(
            initialChunkRef.current,
            audio.duration - 1,
          );
        }
        updateProgress();
      };
      audio.onended = () => {
        if (stoppedRef.current) return; // guard: chapter changed before audio finished
        stoppedRef.current = true;
        setIsPlaying(false);
        setIsBuffering(false);
        setChunkIndex(0);
        onEndedRef.current?.();
      };

      if (startPlay) {
        stoppedRef.current = false;
        setIsPlaying(true);
        setIsBuffering(true);
        audio
          .play()
          .then(() => setIsBuffering(false))
          .catch(() => {
            stoppedRef.current = true;
            setIsPlaying(false);
            setIsBuffering(false);
          });
      }
    },
    [],
  );

  // playChunk defined via ref to avoid stale closures in recursive calls
  const playChunkRef = useRef<(index: number) => Promise<void>>(null!);
  playChunkRef.current = async (index: number) => {
    if (stoppedRef.current) return;
    if (index >= chunksRef.current.length) {
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
      setChunkIndex(0);
      chunkRef.current = 0;
      onEndedRef.current?.();
      return;
    }

    setIsBuffering(true);
    // Pre-warm 3 chunks ahead for smoother transitions
    prefetch(index);
    prefetch(index + 1);
    prefetch(index + 2);

    try {
      const url = await prefetchRef.current.get(index)!;
      if (stoppedRef.current) return;

      const audio = audioRef.current!;
      audio.src = url;
      audio.playbackRate = rateRef.current;
      audio.onended = () => {
        if (stoppedRef.current) return;
        playChunkRef.current!(index + 1);
      };

      setIsBuffering(false);
      setChunkIndex(index);
      chunkRef.current = index;

      try {
        await audio.play();
      } catch (err) {
        if (stoppedRef.current) return;
        const name = (err as Error).name;
        if (name === "AbortError") {
          // Transient browser interruption — retry once after a brief pause
          await new Promise((r) => setTimeout(r, 150));
          if (!stoppedRef.current) {
            await audio.play().catch(() => {
              if (!stoppedRef.current) {
                stoppedRef.current = true;
                setIsPlaying(false);
                setIsBuffering(false);
              }
            });
          }
        } else {
          // NotAllowedError or other hard stop
          stoppedRef.current = true;
          setIsPlaying(false);
          setIsBuffering(false);
        }
      }
    } catch (err) {
      // fetchChunkAudio only throws on AbortError (chapter/voice changed)
      if ((err as Error).name !== "AbortError" && !stoppedRef.current) {
        stoppedRef.current = true;
        setIsPlaying(false);
        setIsBuffering(false);
      }
    }
  };

  // Reset & set up player when chapter changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // If already playing a full-audio cached chapter and text arrives late (same
    // chapter, isLoadingText true→false), skip the restart entirely. Pausing and
    // re-fetching the same blob would cause a noticeable interruption with no benefit
    // since full-mode doesn't need the text to play.
    if (modeRef.current === "full" && !stoppedRef.current) return;

    // Cancel inflight fetches for the previous chapter
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    audio.pause();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);

    // Revoke any previous full-audio blob
    if (fullBlobUrlRef.current) {
      URL.revokeObjectURL(fullBlobUrlRef.current);
      fullBlobUrlRef.current = null;
    }

    // Revoke and clear streaming blobs
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
    blobUrlsRef.current = [];
    prefetchRef.current.clear();

    // Check Cache API first
    getCachedAudioUrl(chapterId, voiceRef.current).then((cachedUrl) => {
      if (stoppedRef.current === false) return; // user already pressed play, skip
      if (cachedUrl) {
        // ── FULL MODE ────────────────────────────────────────────────
        fullBlobUrlRef.current = cachedUrl;
        setupFullAudio(audio, cachedUrl, !!autoPlay);
      } else {
        // ── STREAMING MODE ───────────────────────────────────────────
        modeRef.current = "streaming";
        const startIdx = autoPlay ? 0 : initialChunkRef.current;
        chunksRef.current = text ? splitIntoChunks(text) : [];
        setTotalChunks(chunksRef.current.length);
        setChunkIndex(startIdx);
        chunkRef.current = startIdx;

        // Transfer any pre-fetched audio from cross-chapter cache
        // (populated by prefetchNextChapterAudio before navigation)
        for (
          let i = startIdx;
          i < Math.min(startIdx + 3, chunksRef.current.length);
          i++
        ) {
          const ck = ccKey(chapterId, i, voiceRef.current);
          const cached = crossChapterCache.get(ck);
          if (cached) {
            prefetchRef.current.set(
              i,
              cached.then((url) => {
                blobUrlsRef.current.push(url);
                return url;
              }),
            );
          }
        }
        crossChapterCache.clear();
        crossChapterAbort.ctrl = null;

        if (chunksRef.current.length > startIdx) prefetch(startIdx);
        if (chunksRef.current.length > startIdx + 1) prefetch(startIdx + 1);
        if (chunksRef.current.length > startIdx + 2) prefetch(startIdx + 2);

        if (autoPlay && chunksRef.current.length > 0) {
          stoppedRef.current = false;
          setIsPlaying(true);
          // Start immediately — no delay. The first chunk may already be
          // in the cross-chapter cache, giving near-instant playback.
          playChunkRef.current!(startIdx);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, text]);

  // Called when voice changes — invalidate cache and restart
  const restartChunk = useCallback(() => {
    const audio = audioRef.current!;
    const wasPlaying = !stoppedRef.current;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    audio.pause();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);

    // Revoke old full blob
    if (fullBlobUrlRef.current) {
      URL.revokeObjectURL(fullBlobUrlRef.current);
      fullBlobUrlRef.current = null;
    }
    // Revoke streaming blobs
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
    blobUrlsRef.current = [];
    prefetchRef.current.clear();

    // Re-check Cache API with new voice
    getCachedAudioUrl(chapterId, voiceRef.current).then((cachedUrl) => {
      if (cachedUrl) {
        fullBlobUrlRef.current = cachedUrl;
        setupFullAudio(audio, cachedUrl, wasPlaying);
      } else {
        modeRef.current = "streaming";
        prefetch(chunkRef.current);
        prefetch(chunkRef.current + 1);
        prefetch(chunkRef.current + 2);
        if (wasPlaying) {
          stoppedRef.current = false;
          setIsPlaying(true);
          setTimeout(() => {
            if (!stoppedRef.current) playChunkRef.current!(chunkRef.current);
          }, 50);
        }
      }
    });
  }, [chapterId, prefetch, setupFullAudio]);

  /**
   * Seek forward or backward by `delta` steps.
   * - Streaming mode: 1 step = 1 chunk (≈5% with targetCount=20).
   * - Full mode: 1 step = 5% of total duration.
   * Pass a fractional delta (e.g. from a progress-bar click) for arbitrary seeking.
   */
  const seekChunk = useCallback(
    (delta: number) => {
      const audio = audioRef.current!;

      if (modeRef.current === "full") {
        if (!audio.duration) return;
        const step = audio.duration / 20;
        audio.currentTime = Math.max(
          0,
          Math.min(audio.duration - 0.5, audio.currentTime + delta * step),
        );
        return;
      }

      // Streaming mode
      const maxIdx = chunksRef.current.length - 1;
      if (maxIdx < 0) return;
      const idx = Math.max(
        0,
        Math.min(Math.round(chunkRef.current + delta), maxIdx),
      );
      if (idx === chunkRef.current && Math.round(delta) === 0) return;

      const wasPlaying = !stoppedRef.current;
      audio.pause();
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);

      setChunkIndex(idx);
      chunkRef.current = idx;

      prefetch(idx);
      prefetch(idx + 1);
      prefetch(idx + 2);

      if (wasPlaying) {
        stoppedRef.current = false;
        setIsPlaying(true);
        playChunkRef.current!(idx);
      }
    },
    [prefetch],
  );

  // When initialChunkIndex arrives late (async progress load), apply it if player hasn't started.
  // This handles the case where listenProgress loads after the chapter-change effect has run.
  useEffect(() => {
    if (
      !stoppedRef.current ||
      initialChunkIndex == null ||
      initialChunkIndex <= 0
    )
      return;
    if (modeRef.current === "streaming") {
      const maxIdx = chunksRef.current.length - 1;
      if (maxIdx >= 0) {
        const idx = Math.min(initialChunkIndex, maxIdx);
        setChunkIndex(idx);
        chunkRef.current = idx;
      }
    } else if (modeRef.current === "full") {
      const audio = audioRef.current;
      if (audio && audio.duration > 0) {
        const seekTo = Math.min(initialChunkIndex, audio.duration - 1);
        audio.currentTime = seekTo;
        setChunkIndex(Math.floor(seekTo));
      }
    }
  }, [initialChunkIndex]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
      blobUrlsRef.current.forEach(URL.revokeObjectURL);
    },
    [],
  );

  // Resume playback when the screen turns back on.
  // With screen off the browser may suspend JS mid-chunk-fetch; the audio
  // element ends up paused while stoppedRef is still false (we think we're
  // playing). Re-start the current chunk so playback continues seamlessly.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const audio = audioRef.current;
      if (!audio || stoppedRef.current) return; // not playing, nothing to do
      if (!audio.paused) return; // still running, nothing to do

      if (modeRef.current === "full") {
        audio.play().catch(() => {});
      } else {
        // Re-enter the chunk loop at the current position
        playChunkRef.current!(chunkRef.current);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current!;
    // Use the ref (not state) to determine current play state.
    // State values captured in a useCallback closure can be stale when toggle
    // is called from outside React (e.g. sleep timer setInterval, mediaSession),
    // causing the wrong branch to execute. stoppedRef is always up-to-date.
    const playing = !stoppedRef.current;
    if (modeRef.current === "full") {
      if (!fullBlobUrlRef.current) return;
      if (playing) {
        audio.pause();
        stoppedRef.current = true;
        setIsPlaying(false);
        setIsBuffering(false);
      } else {
        stoppedRef.current = false;
        setIsPlaying(true);
        audio.play().catch(() => {
          stoppedRef.current = true;
          setIsPlaying(false);
        });
      }
    } else {
      if (!chunksRef.current.length) return;
      if (playing) {
        audio.pause();
        stoppedRef.current = true;
        setIsPlaying(false);
        setIsBuffering(false);
      } else {
        stoppedRef.current = false;
        setIsPlaying(true);
        playChunkRef.current!(chunkRef.current);
      }
    }
  }, []);

  const changeRate = useCallback((newRate: number) => {
    rateRef.current = newRate;
    setRateState(newRate);
    if (audioRef.current) audioRef.current.playbackRate = newRate;
  }, []);

  const progress = totalChunks > 0 ? chunkIndex / totalChunks : 0;
  const mode = modeRef.current;

  return {
    isPlaying: isPlaying || isBuffering,
    isBuffering,
    isOffline,
    mode,
    progress,
    chunkIndex,
    totalChunks,
    rate,
    toggle,
    changeRate,
    restartChunk,
    seekChunk,
  };
}
