"use client";
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { Chapter, Book } from "@/types";
import { useSpeechPlayer } from "@/hooks/useSpeechPlayer";
import { useNativeTTSPlayer } from "@/hooks/useNativeTTSPlayer";
import { isNativePlatform } from "@/lib/capacitor";
import {
  useChapterAudioPreload,
  type CacheStatus,
} from "@/hooks/useChapterAudioPreload";
import { useSleepTimer } from "@/hooks/useSleepTimer";

const VOICE_STORAGE_KEY = "tts-voice";

/** All metadata the player needs for a given chapter. */
export interface PlayerTrack {
  bookId: string;
  chapterId: string;
  chapter: Chapter;
  book: Book;
  text: string | null | undefined;
  isLoadingText: boolean;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onEnded?: () => void;
  neighborChapters: { id: string }[];
  initialChunkIndex?: number;
  autoPlay?: boolean;
}

interface PlayerContextValue {
  // Current track (null = nothing loaded yet)
  track: PlayerTrack | null;
  setTrack: (track: PlayerTrack) => void;
  clearTrack: () => void;

  // Voice selection (lifted so MiniPlayer + SpeechPlayer share one source)
  voice: string;
  setVoice: (v: string) => void;

  // Player state (from useSpeechPlayer)
  isPlaying: boolean;
  isBuffering: boolean;
  isOffline: boolean;
  mode: "streaming" | "full";
  progress: number;
  chunkIndex: number;
  totalChunks: number;
  rate: number;
  toggle: () => void;
  changeRate: (r: number) => void;
  restartChunk: () => void;
  seekChunk: (delta: number) => void;

  // Cache statuses (from useChapterAudioPreload)
  cacheStatuses: Record<string, CacheStatus>;

  // Sleep timer
  sleepRemaining: number | null; // seconds remaining, null = inactive
  setSleepTimer: (minutes: number) => void;
  cancelSleepTimer: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

/** Inner component that actually calls the hooks. */
function PlayerProviderInner({ children }: { children: ReactNode }) {
  const [track, setTrackState] = useState<PlayerTrack | null>(null);

  const [voice, setVoiceState] = useState<string>(() => {
    if (typeof window === "undefined") return "vi-VN-HoaiMyNeural";
    const stored = localStorage.getItem(VOICE_STORAGE_KEY);
    // Discard any leftover "browser:" value from the removed feature
    if (stored && !stored.startsWith("browser:")) return stored;
    if (isNativePlatform()) return "native:vi-VN-default";
    return "vi-VN-HoaiMyNeural";
  });

  const setTrack = useCallback((newTrack: PlayerTrack) => {
    setTrackState(newTrack);
  }, []);

  const clearTrack = useCallback(() => setTrackState(null), []);

  const setVoice = useCallback((v: string) => {
    setVoiceState(v);
    localStorage.setItem(VOICE_STORAGE_KEY, v);
  }, []);

  // Determine which TTS engine to use based on voice prefix.
  // Both hooks are always called (React rules), but the inactive one
  // receives null text so it stays completely idle.
  const isNativeVoice = voice.startsWith("native:");

  // The single instance of the player — survives route changes because
  // PlayerProvider lives in the root layout, not inside any page.
  const backendPlayer = useSpeechPlayer(
    track?.bookId ?? "",
    track?.chapterId ?? "",
    isNativeVoice ? null : track?.text,
    isNativeVoice ? null : voice,
    track?.onEnded,
    track?.autoPlay,
    track?.initialChunkIndex,
  );

  // Native TTS (Capacitor — Android/iOS)
  const nativePlayer = useNativeTTSPlayer(
    track?.bookId ?? "",
    track?.chapterId ?? "",
    isNativeVoice ? track?.text : null,
    isNativeVoice ? voice : null,
    track?.onEnded,
    track?.autoPlay,
    track?.initialChunkIndex,
  );

  const playerState = isNativeVoice ? nativePlayer : backendPlayer;

  const { cacheStatuses } = useChapterAudioPreload(
    track?.neighborChapters ?? [],
    voice,
  );

  // Sleep timer — pause playback when it fires
  // Use a ref so the stable callback can always see the latest playerState
  const playerStateRef = useRef(playerState);
  playerStateRef.current = playerState;
  const handleSleepExpire = useCallback(() => {
    if (playerStateRef.current.isPlaying) playerStateRef.current.toggle();
  }, []);
  const {
    remaining: sleepRemaining,
    setTimer: setSleepTimer,
    cancelTimer: cancelSleepTimer,
  } = useSleepTimer(handleSleepExpire);

  const value: PlayerContextValue = {
    track,
    setTrack,
    clearTrack,
    voice,
    setVoice,
    ...playerState,
    cacheStatuses,
    sleepRemaining,
    setSleepTimer,
    cancelSleepTimer,
  };

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  return <PlayerProviderInner>{children}</PlayerProviderInner>;
}

export function usePlayerContext() {
  const ctx = useContext(PlayerContext);
  if (!ctx)
    throw new Error("usePlayerContext must be used within PlayerProvider");
  return ctx;
}
