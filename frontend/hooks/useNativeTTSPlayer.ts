"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useProgressSync } from "@/hooks/useProgressSync";
import { isNativePlatform } from "@/lib/capacitor";
import {
  acquireBackgroundLock,
  releaseBackgroundLock,
  getTtsBridge,
} from "@/lib/backgroundLock";
import { splitIntoChunks } from "@/lib/textChunks";

/**
 * Returns available native TTS voices for the given language.
 * On native platform we only expose a single "device default" voice.
 */
export function useNativeTTSVoices(lang = "vi") {
  const [voices, setVoices] = useState<
    { index: number; name: string; lang: string }[]
  >([]);

  useEffect(() => {
    if (!isNativePlatform()) return;
    setVoices([{ index: 0, name: "Giọng thiết bị", lang: `${lang}-VN` }]);
  }, [lang]);

  return voices;
}

/**
 * Whether native TTS is available on this device.
 */
export function useNativeTTSAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!isNativePlatform()) return;
    setAvailable(true);
  }, []);
  return available;
}

/**
 * Plays book chapter text using the device's native TTS engine via the
 * Android TtsPlaybackService. The entire chunk loop runs in native Java,
 * so playback continues even when the WebView is suspended (screen off).
 *
 * JS only sends chunks to native and listens for progress events.
 */
export function useNativeTTSPlayer(
  bookId: string,
  chapterId: string,
  text: string | null | undefined,
  voiceName: string | null,
  onEnded?: (nativeChapterId?: string) => void,
  autoPlay?: boolean,
  initialChunkIndex?: number,
) {
  const isActive = !!voiceName?.startsWith("native:");

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [rate, setRateState] = useState(1);
  const [pitch, setPitchState] = useState(1);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const chunksRef = useRef<string[]>([]);
  const chunkRef = useRef(0);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const pitchRef = useRef(1);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // Set when the native service auto-advances to the next chapter.
  // Prevents the reset effect from stopping the already-playing service.
  const chapterAdvancedRef = useRef(false);

  const { reportProgress: reportListenProgress } = useProgressSync({
    bookId,
    chapterId,
  });

  const chapterIdRef = useRef(chapterId);
  chapterIdRef.current = chapterId;

  // Send chunks to native and start playback
  const startNativePlayback = useCallback((startIdx: number) => {
    const bridge = getTtsBridge();
    if (!bridge || chunksRef.current.length === 0) return;

    const chunksJson = JSON.stringify(chunksRef.current);
    try {
      // Use playChunksWithId (sends chapterId to native) if available,
      // fall back to playChunks for older APKs that lack the new method.
      if (typeof bridge.playChunksWithId === "function") {
        bridge.playChunksWithId(
          chunksJson,
          rateRef.current,
          pitchRef.current,
          startIdx,
          "Đang phát...",
          chapterIdRef.current,
        );
      } else {
        bridge.playChunks(
          chunksJson,
          rateRef.current,
          pitchRef.current,
          startIdx,
          "Đang phát...",
        );
      }
      playingRef.current = true;
      setIsPlaying(true);
      setIsBuffering(false);
      setChunkIndex(startIdx);
      chunkRef.current = startIdx;
    } catch {
      // Bridge call failed — clear buffering so UI isn't stuck
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
    }
  }, []);

  // Listen for native TTS events
  useEffect(() => {
    if (!isActive) return;

    const onChunk = (e: Event) => {
      const idx = (e as CustomEvent).detail?.index ?? 0;
      // Only update state & report progress if native is still on this JS chapter.
      // When native auto-advances chapters in the background, chunk events arrive
      // for a different chapter — saving them would corrupt this chapter's progress.
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      if (nativeChId && nativeChId !== chapterIdRef.current) return;

      setChunkIndex(idx);
      chunkRef.current = idx;
      setIsBuffering(false);
      reportListenProgress(idx, chunksRef.current.length);
    };

    const onChapterAdvance = () => {
      // The native service auto-advanced to the queued next chapter.
      // Set a flag so the reset effect (triggered by the upcoming navigation)
      // doesn't stop the service that's already playing.
      chapterAdvancedRef.current = true;
      // Pass the native bridge's actual current chapter ID so the navigation
      // target is always what native is ACTUALLY playing, not a stale JS closure.
      // This prevents cascade skips when native advances faster than React renders.
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? undefined;
      onEndedRef.current?.(nativeChId);
    };

    const onDone = () => {
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
      setChunkIndex(0);
      chunkRef.current = 0;
      // Do NOT release the background lock here — the next chapter's autoPlay
      // needs the service alive so sInstance is non-null and ttsReady is true.
      // The lock is released on unmount or when isActive becomes false.

      // If the service auto-advanced, onChapterAdvance already called onEnded.
      // Don't call it again to avoid double navigation.
      if (!chapterAdvancedRef.current) {
        onEndedRef.current?.();
      }
      chapterAdvancedRef.current = false;
    };

    const onState = (e: Event) => {
      const { playing, index } = (e as CustomEvent).detail ?? {};
      // Only sync state if native is still on this JS chapter.
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      if (nativeChId && nativeChId !== chapterIdRef.current) return;

      playingRef.current = playing;
      setIsPlaying(playing);
      setIsBuffering(false);
      if (index !== undefined) {
        setChunkIndex(index);
        chunkRef.current = index;
      }
    };

    window.addEventListener("native-tts-chunk", onChunk);
    window.addEventListener("native-tts-chapter-advance", onChapterAdvance);
    window.addEventListener("native-tts-done", onDone);
    window.addEventListener("native-tts-state", onState);

    return () => {
      window.removeEventListener("native-tts-chunk", onChunk);
      window.removeEventListener(
        "native-tts-chapter-advance",
        onChapterAdvance,
      );
      window.removeEventListener("native-tts-done", onDone);
      window.removeEventListener("native-tts-state", onState);
    };
  }, [isActive, reportListenProgress]);

  // Reset when chapter / text / active state changes
  useEffect(() => {
    setTtsError(null);

    const wasAutoAdvanced = chapterAdvancedRef.current;

    // If the native service auto-advanced to this chapter, DON'T stop it.
    // It's already playing the right content.
    if (isActive && !wasAutoAdvanced) {
      getTtsBridge()?.stopPlayback();
    }

    if (!isActive || !text) {
      if (!wasAutoAdvanced) {
        playingRef.current = false;
        setIsPlaying(false);
        setIsBuffering(false);
      }
      // Only release the service when the engine is deactivated entirely.
      // When text is just temporarily null during a chapter transition, keep
      // the service alive so TTS engine stays initialized and ready.
      if (!isActive) releaseBackgroundLock();
      if (!wasAutoAdvanced) {
        chunksRef.current = [];
        setTotalChunks(0);
      }
      return;
    }

    // Text is available — split chunks for progress tracking
    chunksRef.current = splitIntoChunks(text);
    setTotalChunks(chunksRef.current.length);

    if (wasAutoAdvanced) {
      // Service auto-advanced — sync JS state with what's already playing.
      chapterAdvancedRef.current = false;
      const bridge = getTtsBridge();

      // Verify native is actually still on THIS chapter. If native already
      // moved further ahead, don't sync — the ListenPageClient visibility
      // handler will navigate to the correct chapter.
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      if (nativeChId && nativeChId !== chapterId) {
        setChunkIndex(0);
        chunkRef.current = 0;
        playingRef.current = false;
        setIsPlaying(false);
        setIsBuffering(false);
        return;
      }

      const idx = bridge?.getCurrentChunk() ?? 0;
      setChunkIndex(idx >= 0 ? idx : 0);
      chunkRef.current = idx >= 0 ? idx : 0;
      const playing = bridge?.isPlaying() ?? false;
      playingRef.current = playing;
      setIsPlaying(playing);
      setIsBuffering(false);
      return;
    }

    // Normal path: fresh start for this chapter
    const startIdx = initialChunkIndex ?? 0;
    setChunkIndex(0);
    chunkRef.current = 0;
    if (startIdx > 0) {
      setChunkIndex(startIdx);
      chunkRef.current = startIdx;
    }

    if (autoPlay && chunksRef.current.length > 0) {
      setIsBuffering(true);
      acquireBackgroundLock();
      // Start native playback immediately — no microtask defer
      startNativePlayback(startIdx);
    } else {
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, text, isActive]);

  // When initialChunkIndex arrives late (async progress load)
  useEffect(() => {
    if (
      playingRef.current ||
      initialChunkIndex == null ||
      initialChunkIndex <= 0
    )
      return;
    const maxIdx = chunksRef.current.length - 1;
    if (maxIdx >= 0) {
      const idx = Math.min(initialChunkIndex, maxIdx);
      setChunkIndex(idx);
      chunkRef.current = idx;
    }
  }, [initialChunkIndex]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (isActive) {
        getTtsBridge()?.stopPlayback();
      }
      releaseBackgroundLock();
    },
    [isActive],
  );

  // Sync JS state with native service when app resumes from background.
  // Earbud play/pause events are handled natively in Java but the JS state
  // updates (dispatched via evaluateJavascript) are lost when WebView is suspended.
  useEffect(() => {
    if (!isActive) return;
    const syncState = () => {
      if (document.visibilityState !== "visible") return;
      const bridge = getTtsBridge();
      if (!bridge) return;

      // Only sync chunk index if native is playing this JS chapter.
      // If native moved ahead, the ListenPageClient visibility handler
      // will navigate to the correct chapter.
      const nativeChId = bridge.getCurrentChapterId?.() ?? "";
      if (nativeChId && nativeChId !== chapterIdRef.current) return;

      const nativePlaying = bridge.isPlaying();
      const nativeIdx = bridge.getCurrentChunk();
      playingRef.current = nativePlaying;
      setIsPlaying(nativePlaying);
      setIsBuffering(false);
      if (nativeIdx >= 0) {
        setChunkIndex(nativeIdx);
        chunkRef.current = nativeIdx;
      }
    };
    document.addEventListener("visibilitychange", syncState);
    return () => document.removeEventListener("visibilitychange", syncState);
  }, [isActive]);

  const toggle = useCallback(async () => {
    if (!isActive) return;
    setTtsError(null);
    const bridge = getTtsBridge();
    if (!bridge) return;

    if (playingRef.current) {
      bridge.pausePlayback();
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
    } else {
      if (!chunksRef.current.length) return;
      // If native has chunks loaded, just resume; otherwise start fresh
      if (bridge.getCurrentChunk() >= 0) {
        bridge.resumePlayback();
        playingRef.current = true;
        setIsPlaying(true);
      } else {
        setIsBuffering(true);
        acquireBackgroundLock();
        startNativePlayback(chunkRef.current);
      }
    }
  }, [isActive, startNativePlayback]);

  const changeRate = useCallback(
    (newRate: number) => {
      rateRef.current = newRate;
      setRateState(newRate);
      getTtsBridge()?.setRate(newRate);
      // If currently playing, restart current chunk with new rate
      if (playingRef.current && chunksRef.current.length > 0) {
        startNativePlayback(chunkRef.current);
      }
    },
    [startNativePlayback],
  );

  const changePitch = useCallback(
    (newPitch: number) => {
      pitchRef.current = newPitch;
      setPitchState(newPitch);
      getTtsBridge()?.setPitch(newPitch);
      if (playingRef.current && chunksRef.current.length > 0) {
        startNativePlayback(chunkRef.current);
      }
    },
    [startNativePlayback],
  );

  const restartChunk = useCallback(() => {
    if (!isActive) return;
    if (playingRef.current) {
      startNativePlayback(chunkRef.current);
    }
  }, [isActive, startNativePlayback]);

  const seekChunk = useCallback(
    (delta: number) => {
      const maxIdx = chunksRef.current.length - 1;
      if (maxIdx < 0) return;
      const idx = Math.max(
        0,
        Math.min(Math.round(chunkRef.current + delta), maxIdx),
      );

      setChunkIndex(idx);
      chunkRef.current = idx;
      reportListenProgress(idx, chunksRef.current.length);

      if (playingRef.current) {
        startNativePlayback(idx);
      }
    },
    [reportListenProgress, startNativePlayback],
  );

  const progress =
    totalChunks > 0 ? Math.max(0, Math.min(1, chunkIndex / totalChunks)) : 0;

  return {
    isPlaying: isPlaying || isBuffering,
    isBuffering,
    isOffline: false,
    mode: "streaming" as const,
    progress,
    chunkIndex,
    totalChunks,
    rate,
    pitch,
    toggle,
    changeRate,
    changePitch,
    restartChunk,
    seekChunk,
    ttsError,
  };
}
