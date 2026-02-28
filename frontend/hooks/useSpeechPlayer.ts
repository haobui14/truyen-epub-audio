"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from "@/lib/constants";
import { useProgressSync } from "@/hooks/useProgressSync";
import { getCachedAudioUrl } from "@/lib/audioFileCache";

/** Split text into ~600-char chunks at sentence boundaries */
function splitChunks(text: string, maxLen = 600): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > maxLen && cur.length > 0) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/** Wait until the browser has a network connection. */
function waitForOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise((resolve) =>
    window.addEventListener("online", () => resolve(), { once: true })
  );
}

/**
 * POST text + voice to backend, return a blob URL.
 * Retries indefinitely, pausing when offline — never rejects.
 */
async function fetchChunkAudio(text: string, voice: string): Promise<string> {
  for (;;) {
    await waitForOnline();
    try {
      const res = await fetch(`${API_URL}/api/tts/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });
      if (!res.ok) throw new Error(`TTS error ${res.status}`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      // Back off 2 s before retrying (handles transient errors)
      await new Promise((r) => setTimeout(r, 2000));
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
  initialChunkIndex?: number
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
    return () => { audioRef.current?.pause(); };
  }, []);

  const prefetch = useCallback((index: number) => {
    if (index < 0 || index >= chunksRef.current.length) return;
    if (!prefetchRef.current.has(index)) {
      prefetchRef.current.set(
        index,
        fetchChunkAudio(chunksRef.current[index], voiceRef.current)
      );
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
      audio.onloadedmetadata = updateProgress;
      audio.onended = () => {
        stoppedRef.current = true;
        setIsPlaying(false);
        setChunkIndex(0);
        onEndedRef.current?.();
      };

      if (startPlay) {
        stoppedRef.current = false;
        setIsPlaying(true);
        setIsBuffering(true);
        audio.play()
          .then(() => setIsBuffering(false))
          .catch(() => {
            stoppedRef.current = true;
            setIsPlaying(false);
            setIsBuffering(false);
          });
      }
    },
    [reportListenProgress]
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
    prefetch(index);
    prefetch(index + 1);

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
      await audio.play();
    } catch {
      // fetchChunkAudio never rejects (retries indefinitely), so this
      // only triggers if the player was stopped while buffering.
      if (!stoppedRef.current) {
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

    audio.pause();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);

    // Revoke any previous full-audio blob
    if (fullBlobUrlRef.current) {
      URL.revokeObjectURL(fullBlobUrlRef.current);
      fullBlobUrlRef.current = null;
    }

    // Clear streaming state
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
        chunksRef.current = text ? splitChunks(text) : [];
        setTotalChunks(chunksRef.current.length);
        setChunkIndex(startIdx);
        chunkRef.current = startIdx;

        if (chunksRef.current.length > startIdx) prefetch(startIdx);
        if (chunksRef.current.length > startIdx + 1) prefetch(startIdx + 1);

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
    audio.pause();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);

    // Revoke old full blob
    if (fullBlobUrlRef.current) {
      URL.revokeObjectURL(fullBlobUrlRef.current);
      fullBlobUrlRef.current = null;
    }
    // Clear streaming cache
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

  // Cleanup on unmount
  useEffect(() => () => {
    audioRef.current?.pause();
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
  }, []);

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
  };
}
