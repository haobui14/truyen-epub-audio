"use client";
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { Chapter, Book } from "@/types";
import { useSpeechPlayer } from "@/hooks/useSpeechPlayer";
import { useNativeTTSPlayer } from "@/hooks/useNativeTTSPlayer";
import { isNativePlatform } from "@/lib/capacitor";
import { getTtsBridge } from "@/lib/backgroundLock";
import {
  useChapterAudioPreload,
  type CacheStatus,
} from "@/hooks/useChapterAudioPreload";
import { useSleepTimer } from "@/hooks/useSleepTimer";
import { api } from "@/lib/api";
import { isLoggedIn } from "@/lib/auth";

const VOICE_STORAGE_KEY = "tts-voice";
const RATE_STORAGE_KEY = "tts-playback-rate";
const PITCH_STORAGE_KEY = "tts-playback-pitch";

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
  onEnded?: (nativeChapterId?: string) => void;
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
  pitch: number;
  toggle: () => void;
  changeRate: (r: number) => void;
  changePitch: (p: number) => void;
  restartChunk: () => void;
  seekChunk: (delta: number) => void;

  // Cache statuses (from useChapterAudioPreload)
  cacheStatuses: Record<string, CacheStatus>;

  // Native TTS error message (null = no error)
  nativeTtsError: string | null;

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
    // On native platform, only allow native voices (device TTS, offline)
    if (isNativePlatform()) {
      const stored = localStorage.getItem(VOICE_STORAGE_KEY);
      if (stored?.startsWith("native:")) return stored;
      return "native:vi-VN-default";
    }
    const stored = localStorage.getItem(VOICE_STORAGE_KEY);
    if (stored && !stored.startsWith("browser:")) return stored;
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

  // Destructure ttsError and pitch out so they are handled explicitly
  const { ttsError: nativeTtsErr, pitch: nativePitch, changePitch: nativeChangePitch, ...nativePlayerRest } = nativePlayer;
  const playerState = isNativeVoice
    ? { ...nativePlayerRest, pitch: nativePitch, changePitch: nativeChangePitch }
    : { ...backendPlayer, pitch: 1, changePitch: () => {} };

  const { cacheStatuses } = useChapterAudioPreload(
    track?.neighborChapters ?? [],
    voice,
  );

  // Sleep timer — pause playback when it fires
  // Use a ref so the stable callback can always see the latest playerState
  const playerStateRef = useRef(playerState);
  playerStateRef.current = playerState;

  // ── Sync playback rate & pitch with user account ──
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1. Apply localStorage values on mount (instant, before backend query returns)
  useEffect(() => {
    const storedRate = localStorage.getItem(RATE_STORAGE_KEY);
    const storedPitch = localStorage.getItem(PITCH_STORAGE_KEY);
    if (storedRate) playerStateRef.current.changeRate(parseFloat(storedRate));
    if (storedPitch) playerStateRef.current.changePitch(parseFloat(storedPitch));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 2. Fetch settings from backend when logged in
  const { data: userSettings } = useQuery({
    queryKey: ["user-settings"],
    queryFn: () => api.getSettings(),
    enabled: isLoggedIn(),
    staleTime: Infinity,
  });

  // 3. When backend settings arrive, apply them (overrides localStorage)
  useEffect(() => {
    if (!userSettings) return;
    const { playback_rate, playback_pitch } = userSettings;
    if (playback_rate !== 1 || localStorage.getItem(RATE_STORAGE_KEY)) {
      playerStateRef.current.changeRate(playback_rate);
      localStorage.setItem(RATE_STORAGE_KEY, String(playback_rate));
    }
    if (playback_pitch !== 1 || localStorage.getItem(PITCH_STORAGE_KEY)) {
      playerStateRef.current.changePitch(playback_pitch);
      localStorage.setItem(PITCH_STORAGE_KEY, String(playback_pitch));
    }
  }, [userSettings]);

  // 4. Debounced save to backend
  const debounceSaveSettings = useCallback(() => {
    if (!isLoggedIn()) return;
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = setTimeout(() => {
      const rate = parseFloat(localStorage.getItem(RATE_STORAGE_KEY) ?? "1");
      const pitch = parseFloat(localStorage.getItem(PITCH_STORAGE_KEY) ?? "1");
      api.saveSettings({ playback_rate: rate, playback_pitch: pitch }).catch(() => {});
    }, 2000);
  }, []);

  // Clean up save timer on unmount
  useEffect(() => () => {
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
  }, []);

  // 5. Wrapped changeRate / changePitch that also persist
  const wrappedChangeRate = useCallback((r: number) => {
    playerStateRef.current.changeRate(r);
    localStorage.setItem(RATE_STORAGE_KEY, String(r));
    debounceSaveSettings();
  }, [debounceSaveSettings]);

  const wrappedChangePitch = useCallback((p: number) => {
    playerStateRef.current.changePitch(p);
    localStorage.setItem(PITCH_STORAGE_KEY, String(p));
    debounceSaveSettings();
  }, [debounceSaveSettings]);

  const handleSleepExpire = useCallback(() => {
    if (playerStateRef.current.isPlaying) playerStateRef.current.toggle();
  }, []);
  const {
    remaining: sleepRemaining,
    setTimer: setSleepTimer,
    cancelTimer: cancelSleepTimer,
  } = useSleepTimer(handleSleepExpire);

  // ── Native media controls: prev/next chapter (dispatched from native → JS) ──
  // Play/pause/toggle are now handled entirely in native Java (no JS round-trip),
  // so we only listen for skip events that need chapter navigation logic.
  useEffect(() => {
    if (!isNativePlatform()) return;
    const onPrev = () => { playerStateRef.current.seekChunk(-1); };
    const onNext = () => { playerStateRef.current.seekChunk(1); };
    window.addEventListener("native-media-prev", onPrev);
    window.addEventListener("native-media-next", onNext);
    return () => {
      window.removeEventListener("native-media-prev", onPrev);
      window.removeEventListener("native-media-next", onNext);
    };
  }, []);

  // Update notification title when track changes
  useEffect(() => {
    if (!isNativePlatform() || !track?.chapter?.title) return;
    getTtsBridge()?.updateTitle(track.chapter.title);
  }, [track?.chapter?.title]);

  // ── navigator.mediaSession: register handlers so hardware media buttons
  // (earbuds, Bluetooth, lock-screen) can control playback even in the WebView. ──
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;

    const handleToggle = () => playerStateRef.current.toggle();
    const handlePrev = () => playerStateRef.current.seekChunk(-1);
    const handleNext = () => playerStateRef.current.seekChunk(1);
    const handleStop = () => {
      if (playerStateRef.current.isPlaying) playerStateRef.current.toggle();
    };

    ms.setActionHandler("play", handleToggle);
    ms.setActionHandler("pause", handleToggle);
    ms.setActionHandler("previoustrack", handlePrev);
    ms.setActionHandler("nexttrack", handleNext);
    ms.setActionHandler("stop", handleStop);

    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("previoustrack", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("stop", null);
    };
  }, []);

  // Update mediaSession metadata + playback state so the OS knows what's playing
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (track?.chapter?.title) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.chapter.title,
        artist: track.book?.title ?? "TruyệnAudio",
        album: "TruyệnAudio",
      });
    }
    navigator.mediaSession.playbackState = playerState.isPlaying
      ? "playing"
      : "paused";
  }, [track?.chapter?.title, track?.book?.title, playerState.isPlaying]);

  const value: PlayerContextValue = {
    track,
    setTrack,
    clearTrack,
    voice,
    setVoice,
    ...playerState,
    changeRate: wrappedChangeRate,
    changePitch: wrappedChangePitch,
    cacheStatuses,
    nativeTtsError: isNativeVoice ? (nativeTtsErr ?? null) : null,
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
