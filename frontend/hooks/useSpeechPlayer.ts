"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from "@/lib/constants";
import { useProgressSync } from "@/hooks/useProgressSync";
import { getCachedAudioUrl } from "@/lib/audioFileCache";
import { splitIntoChunks } from "@/lib/textChunks";

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
  onEnded?: () => void,
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

  const { reportProgress: reportListenProgress } = useProgressSync({
    bookId,
    chapterId,
    progressType: "listen",
  });

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
        reportListenProgress(audio.currentTime, audio.duration);
      };
      audio.ontimeupdate = updateProgress;
      audio.onloadedmetadata = () => {
        // Seek to saved position on manual navigation (not autoplay)
        if (!startPlay && initialChunkRef.current > 0 && audio.duration > 0) {
          audio.currentTime = Math.min(initialChunkRef.current, audio.duration - 1);
        }
        updateProgress();
      };
      audio.onended = () => {
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
    [reportListenProgress],
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
      reportListenProgress(index, chunksRef.current.length);

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

        if (chunksRef.current.length > startIdx) prefetch(startIdx);
        if (chunksRef.current.length > startIdx + 1) prefetch(startIdx + 1);
        if (chunksRef.current.length > startIdx + 2) prefetch(startIdx + 2);

        if (autoPlay && chunksRef.current.length > 0) {
          stoppedRef.current = false;
          setIsPlaying(true);
          setTimeout(() => {
            if (!stoppedRef.current) playChunkRef.current!(0);
          }, 100);
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
      const idx = Math.max(0, Math.min(Math.round(chunkRef.current + delta), maxIdx));
      if (idx === chunkRef.current && Math.round(delta) === 0) return;

      const wasPlaying = !stoppedRef.current;
      audio.pause();
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);

      setChunkIndex(idx);
      chunkRef.current = idx;
      reportListenProgress(idx, chunksRef.current.length);

      prefetch(idx);
      prefetch(idx + 1);
      prefetch(idx + 2);

      if (wasPlaying) {
        stoppedRef.current = false;
        setIsPlaying(true);
        playChunkRef.current!(idx);
      }
    },
    [prefetch, reportListenProgress],
  );

  // When initialChunkIndex arrives late (async progress load), apply it if player hasn't started.
  // This handles the case where listenProgress loads after the chapter-change effect has run.
  useEffect(() => {
    if (!stoppedRef.current || initialChunkIndex == null || initialChunkIndex <= 0) return;
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

  const toggle = useCallback(() => {
    const audio = audioRef.current!;
    if (modeRef.current === "full") {
      if (!fullBlobUrlRef.current) return;
      if (isPlaying || isBuffering) {
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
      if (isPlaying || isBuffering) {
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
  }, [isPlaying, isBuffering]);

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
