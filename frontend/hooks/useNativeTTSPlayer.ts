"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useProgressSync } from "@/hooks/useProgressSync";
import { isNativePlatform } from "@/lib/capacitor";
import { acquireBackgroundLock, releaseBackgroundLock, getTtsBridge } from "@/lib/backgroundLock";
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
  onEnded?: () => void,
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

  const { reportProgress: reportListenProgress } = useProgressSync({
    bookId,
    chapterId,
    progressType: "listen",
  });

  // Send chunks to native and start playback
  const startNativePlayback = useCallback((startIdx: number) => {
    const bridge = getTtsBridge();
    if (!bridge || chunksRef.current.length === 0) return;

    const chunksJson = JSON.stringify(chunksRef.current);
    bridge.playChunks(chunksJson, rateRef.current, pitchRef.current, startIdx, "Đang phát...");
    playingRef.current = true;
    setIsPlaying(true);
    setIsBuffering(false);
    setChunkIndex(startIdx);
    chunkRef.current = startIdx;
  }, []);

  // Listen for native TTS events
  useEffect(() => {
    if (!isActive) return;

    const onChunk = (e: Event) => {
      const idx = (e as CustomEvent).detail?.index ?? 0;
      setChunkIndex(idx);
      chunkRef.current = idx;
      setIsBuffering(false);
      reportListenProgress(idx, chunksRef.current.length);
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
      onEndedRef.current?.();
    };

    const onState = (e: Event) => {
      const { playing, index } = (e as CustomEvent).detail ?? {};
      playingRef.current = playing;
      setIsPlaying(playing);
      setIsBuffering(false);
      if (index !== undefined) {
        setChunkIndex(index);
        chunkRef.current = index;
      }
    };

    window.addEventListener("native-tts-chunk", onChunk);
    window.addEventListener("native-tts-done", onDone);
    window.addEventListener("native-tts-state", onState);

    return () => {
      window.removeEventListener("native-tts-chunk", onChunk);
      window.removeEventListener("native-tts-done", onDone);
      window.removeEventListener("native-tts-state", onState);
    };
  }, [isActive, reportListenProgress]);

  // Reset when chapter / text / active state changes
  useEffect(() => {
    setTtsError(null);

    // Stop any in-flight native speech
    if (isActive) {
      getTtsBridge()?.stopPlayback();
    }

    if (!isActive || !text) {
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
      // Only release the service when the engine is deactivated entirely.
      // When text is just temporarily null during a chapter transition, keep
      // the service alive so TTS engine stays initialized and ready.
      if (!isActive) releaseBackgroundLock();
      chunksRef.current = [];
      setTotalChunks(0);
      return;
    }

    const startIdx = initialChunkIndex ?? 0;
    // Reset chunkIndex to 0 FIRST so it can never be stale-high against
    // the incoming totalChunks (avoids progressPct > 100 between renders)
    setChunkIndex(0);
    chunkRef.current = 0;
    chunksRef.current = splitIntoChunks(text);
    setTotalChunks(chunksRef.current.length);
    if (startIdx > 0) {
      setChunkIndex(startIdx);
      chunkRef.current = startIdx;
    }

    if (autoPlay && chunksRef.current.length > 0) {
      setIsBuffering(true);
      acquireBackgroundLock();
      // Start native playback immediately
      Promise.resolve().then(() => startNativePlayback(startIdx));
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

  const changeRate = useCallback((newRate: number) => {
    rateRef.current = newRate;
    setRateState(newRate);
    getTtsBridge()?.setRate(newRate);
    // If currently playing, restart current chunk with new rate
    if (playingRef.current && chunksRef.current.length > 0) {
      startNativePlayback(chunkRef.current);
    }
  }, [startNativePlayback]);

  const changePitch = useCallback((newPitch: number) => {
    pitchRef.current = newPitch;
    setPitchState(newPitch);
    getTtsBridge()?.setPitch(newPitch);
    if (playingRef.current && chunksRef.current.length > 0) {
      startNativePlayback(chunkRef.current);
    }
  }, [startNativePlayback]);

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

  const progress = totalChunks > 0 ? Math.max(0, Math.min(1, chunkIndex / totalChunks)) : 0;

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
