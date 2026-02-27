"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from "@/lib/constants";

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

/** POST text + voice to backend, return a blob URL for the audio */
async function fetchChunkAudio(text: string, voice: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/tts/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(`TTS error ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function useSpeechPlayer(
  chapterId: string,
  text: string | null | undefined,
  voiceName: string | null,
  onEnded?: () => void
) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [rate, setRateState] = useState(1);

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
      await audio.play();
    } catch {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
    }
  };

  // Reset when chapter changes
  useEffect(() => {
    audioRef.current?.pause();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);
    setChunkIndex(0);
    chunkRef.current = 0;
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
    blobUrlsRef.current = [];
    prefetchRef.current.clear();
    chunksRef.current = text ? splitChunks(text) : [];
    if (chunksRef.current.length > 0) prefetch(0);
    if (chunksRef.current.length > 1) prefetch(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, text]);

  // Clear cache and restart when voice changes
  const restartChunk = useCallback(() => {
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
    blobUrlsRef.current = [];
    prefetchRef.current.clear();
    // Re-warm with new voice
    prefetch(chunkRef.current);
    prefetch(chunkRef.current + 1);
    // Restart current chunk if was playing
    if (!stoppedRef.current) {
      audioRef.current?.pause();
      setTimeout(() => {
        if (!stoppedRef.current) playChunkRef.current!(chunkRef.current);
      }, 50);
    }
  }, [prefetch]);

  // Cleanup on unmount
  useEffect(() => () => {
    audioRef.current?.pause();
    blobUrlsRef.current.forEach(URL.revokeObjectURL);
  }, []);

  const toggle = useCallback(() => {
    if (!chunksRef.current.length) return;
    if (isPlaying || isBuffering) {
      audioRef.current?.pause();
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
    } else {
      stoppedRef.current = false;
      setIsPlaying(true);
      playChunkRef.current!(chunkRef.current);
    }
  }, [isPlaying, isBuffering]);

  const changeRate = useCallback((newRate: number) => {
    rateRef.current = newRate;
    setRateState(newRate);
    if (audioRef.current) audioRef.current.playbackRate = newRate;
  }, []);

  const totalChunks = chunksRef.current.length;
  const progress = totalChunks > 0 ? chunkIndex / totalChunks : 0;

  return {
    isPlaying: isPlaying || isBuffering,
    isBuffering,
    progress,
    chunkIndex,
    totalChunks,
    rate,
    toggle,
    changeRate,
    restartChunk,
  };
}
