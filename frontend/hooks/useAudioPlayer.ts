"use client";
import { useRef, useState, useEffect, useCallback } from "react";

const SAVE_INTERVAL_MS = 5000;

function storageKey(chapterId: string) {
  return `audio-progress-${chapterId}`;
}

export function useAudioPlayer(chapterId: string | null, audioUrl: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialize audio element
  useEffect(() => {
    if (!audioUrl) return;

    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    setIsLoading(true);
    setIsPlaying(false);

    // Restore saved position
    if (chapterId) {
      const saved = localStorage.getItem(storageKey(chapterId));
      if (saved) {
        audio.currentTime = parseFloat(saved);
        setCurrentTime(parseFloat(saved));
      }
    }

    audio.playbackRate = playbackRate;

    audio.addEventListener("loadedmetadata", () => {
      setDuration(audio.duration);
      setIsLoading(false);
    });

    audio.addEventListener("timeupdate", () => {
      setCurrentTime(audio.currentTime);
    });

    audio.addEventListener("ended", () => {
      setIsPlaying(false);
      if (chapterId) {
        localStorage.removeItem(storageKey(chapterId));
      }
    });

    audio.addEventListener("error", () => {
      setIsLoading(false);
    });

    // Save progress periodically
    saveTimerRef.current = setInterval(() => {
      if (chapterId && audio.currentTime > 0) {
        localStorage.setItem(storageKey(chapterId), String(audio.currentTime));
      }
    }, SAVE_INTERVAL_MS);

    return () => {
      audio.pause();
      audio.src = "";
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
      audioRef.current = null;
    };
  }, [audioUrl, chapterId]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      setIsPlaying(true);
    } catch (e) {
      console.error("Play error:", e);
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || 0));
  }, []);

  const setSpeed = useCallback((rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, []);

  return {
    isPlaying,
    isLoading,
    currentTime,
    duration,
    playbackRate,
    play,
    pause,
    toggle,
    seek,
    setSpeed,
  };
}
