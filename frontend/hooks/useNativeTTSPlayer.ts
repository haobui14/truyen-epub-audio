"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useProgressSync } from "@/hooks/useProgressSync";
import { isNativePlatform } from "@/lib/capacitor";
import { splitIntoChunks } from "@/lib/textChunks";

// Lazy-import to avoid loading native code on web
type TTSModule = typeof import("@capacitor-community/text-to-speech");
let ttsModule: TTSModule | null = null;

async function getTTS() {
  if (!ttsModule) {
    ttsModule = await import("@capacitor-community/text-to-speech");
  }
  return ttsModule.TextToSpeech;
}

/**
 * Returns available native TTS voices for the given language.
 * Each voice has an `index` field (its position in the full voices array)
 * which is needed by the Capacitor TTS plugin's `voice` option.
 * Only returns results when running inside a Capacitor native shell.
 */
export function useNativeTTSVoices(lang = "vi") {
  const [voices, setVoices] = useState<
    { index: number; name: string; lang: string }[]
  >([]);

  useEffect(() => {
    if (!isNativePlatform()) return;
    (async () => {
      try {
        const tts = await getTTS();
        const result = await tts.getSupportedVoices();
        const filtered = result.voices
          .map((v, i) => ({ index: i, name: v.name, lang: v.lang }))
          .filter((v) => v.lang.startsWith(lang));
        setVoices(filtered);
      } catch {
        setVoices([]);
      }
    })();
  }, [lang]);

  return voices;
}

/**
 * Plays book chapter text using the device's native TTS engine via Capacitor.
 * Works completely offline — no backend calls required.
 * The `voiceName` parameter must start with "native:" when active;
 * pass null to put this hook in idle (no-op) mode.
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

  const chunksRef = useRef<string[]>([]);
  const chunkRef = useRef(0);
  const stoppedRef = useRef(true);
  const rateRef = useRef(1);
  const voiceRef = useRef(voiceName);
  voiceRef.current = voiceName;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const { reportProgress: reportListenProgress } = useProgressSync({
    bookId,
    chapterId,
    progressType: "listen",
  });

  // Forward-declared so the completion callback can call it recursively
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

    // Parse voice index from "native:<number>" format
    const voiceStr = voiceRef.current?.startsWith("native:")
      ? voiceRef.current.slice(7)
      : undefined;
    const voiceIndex =
      voiceStr && voiceStr !== "vi-VN-default"
        ? parseInt(voiceStr, 10)
        : undefined;

    try {
      setChunkIndex(index);
      chunkRef.current = index;
      setIsBuffering(false);
      setIsPlaying(true);
      reportListenProgress(index, chunksRef.current.length);

      const tts = await getTTS();
      // speak() returns a Promise that resolves when the utterance finishes
      await tts.speak({
        text: chunksRef.current[index],
        lang: "vi-VN",
        rate: rateRef.current,
        ...(voiceIndex !== undefined && !isNaN(voiceIndex)
          ? { voice: voiceIndex }
          : {}),
      });

      if (!stoppedRef.current) {
        await playChunkRef.current!(index + 1);
      }
    } catch {
      if (!stoppedRef.current) {
        stoppedRef.current = true;
        setIsPlaying(false);
        setIsBuffering(false);
      }
    }
  };

  // Reset when chapter / text / active state changes
  useEffect(() => {
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);

    if (isActive) {
      getTTS()
        .then((tts) => tts.stop())
        .catch(() => {});
    }

    if (!isActive || !text) {
      chunksRef.current = [];
      setTotalChunks(0);
      return;
    }

    const startIdx = initialChunkIndex ?? 0;
    chunksRef.current = splitIntoChunks(text);
    setTotalChunks(chunksRef.current.length);
    setChunkIndex(startIdx);
    chunkRef.current = startIdx;

    if (autoPlay && chunksRef.current.length > 0) {
      stoppedRef.current = false;
      setIsPlaying(true);
      setIsBuffering(true);
      setTimeout(() => {
        if (!stoppedRef.current) playChunkRef.current!(startIdx);
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, text, isActive]);

  // When initialChunkIndex arrives late (async progress load), apply it if player hasn't started.
  useEffect(() => {
    if (!stoppedRef.current || initialChunkIndex == null || initialChunkIndex <= 0) return;
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
        getTTS()
          .then((tts) => tts.stop())
          .catch(() => {});
      }
    },
    [isActive],
  );

  const toggle = useCallback(async () => {
    if (!isActive) return;
    if (isPlaying || isBuffering) {
      const tts = await getTTS();
      await tts.stop();
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
    } else {
      if (!chunksRef.current.length) return;
      stoppedRef.current = false;
      setIsPlaying(true);
      setIsBuffering(true);
      setTimeout(() => {
        if (!stoppedRef.current) playChunkRef.current!(chunkRef.current);
      }, 50);
    }
  }, [isActive, isPlaying, isBuffering]);

  const changeRate = useCallback((newRate: number) => {
    rateRef.current = newRate;
    setRateState(newRate);
  }, []);

  const restartChunk = useCallback(async () => {
    if (!isActive) return;
    const wasPlaying = !stoppedRef.current;
    const tts = await getTTS();
    await tts.stop();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);
    if (wasPlaying) {
      stoppedRef.current = false;
      setIsPlaying(true);
      setIsBuffering(true);
      setTimeout(() => {
        if (!stoppedRef.current) playChunkRef.current!(chunkRef.current);
      }, 50);
    }
  }, [isActive]);

  const seekChunk = useCallback(
    async (delta: number) => {
      const maxIdx = chunksRef.current.length - 1;
      if (maxIdx < 0) return;
      const idx = Math.max(0, Math.min(Math.round(chunkRef.current + delta), maxIdx));

      const wasPlaying = !stoppedRef.current;
      const tts = await getTTS();
      await tts.stop();
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);

      setChunkIndex(idx);
      chunkRef.current = idx;
      reportListenProgress(idx, chunksRef.current.length);

      if (wasPlaying) {
        stoppedRef.current = false;
        setIsPlaying(true);
        setIsBuffering(true);
        setTimeout(() => {
          if (!stoppedRef.current) playChunkRef.current!(idx);
        }, 50);
      }
    },
    [reportListenProgress],
  );

  const progress = totalChunks > 0 ? chunkIndex / totalChunks : 0;

  return {
    isPlaying: isPlaying || isBuffering,
    isBuffering,
    isOffline: false, // native TTS is always offline-capable
    mode: "streaming" as const,
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
