"use client";
/**
 * PlayerContext — single player instance that survives route changes.
 *
 * Lives in the root layout, so the player hooks (`useSpeechPlayer`,
 * `useNativeTTSPlayer`) are never remounted when the user navigates between
 * `/listen`, `/book`, `/read`, etc. This is what keeps audio playing during
 * navigation.
 *
 * Routes playback to web (edge-tts via backend) or native (Android TTS via
 * `useNativeTTSPlayer`) based on the voice prefix (`native:*` = native).
 *
 * See `docs/android-player.md` for the native TTS architecture.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Chapter, Book } from "@/types";
import {
  saveLocalProgress,
  saveLocalBookProgress,
  syncBookProgressToServer,
} from "@/lib/progressQueue";
import { getCachedAllChapters } from "@/lib/bookCache";
import { useSpeechPlayer } from "@/hooks/useSpeechPlayer";
import { useNativeTTSPlayer } from "@/hooks/useNativeTTSPlayer";
import { isNativePlatform } from "@/lib/capacitor";
import { getTtsBridge, releaseBackgroundLock } from "@/lib/backgroundLock";
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

  // Set when the NATIVE service has a session on a different chapter than the
  // current track — background auto-advance while the user browses other
  // pages, or a session that outlived the WebView (cold start with no track
  // at all). MiniPlayer renders this instead of the stale/absent track.
  nativeChapterOverride: {
    bookId: string;
    bookTitle: string;
    coverUrl: string;
    chapterId: string;
    title: string;
    chunkIndex: number;
    totalChunks: number;
    playing: boolean;
  } | null;

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
    track?.chapter?.title,
  );

  // Destructure ttsError and pitch out so they are handled explicitly
  const {
    ttsError: nativeTtsErr,
    pitch: nativePitch,
    changePitch: nativeChangePitch,
    ...nativePlayerRest
  } = nativePlayer;
  const playerState = isNativeVoice
    ? {
        ...nativePlayerRest,
        pitch: nativePitch,
        changePitch: nativeChangePitch,
      }
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
    if (storedPitch)
      playerStateRef.current.changePitch(parseFloat(storedPitch));
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
      api
        .saveSettings({ playback_rate: rate, playback_pitch: pitch })
        .catch(() => {});
    }, 2000);
  }, []);

  // Clean up save timer on unmount
  useEffect(
    () => () => {
      if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    },
    [],
  );

  // 5. Wrapped changeRate / changePitch that also persist
  const wrappedChangeRate = useCallback(
    (r: number) => {
      playerStateRef.current.changeRate(r);
      localStorage.setItem(RATE_STORAGE_KEY, String(r));
      debounceSaveSettings();
    },
    [debounceSaveSettings],
  );

  const wrappedChangePitch = useCallback(
    (p: number) => {
      playerStateRef.current.changePitch(p);
      localStorage.setItem(PITCH_STORAGE_KEY, String(p));
      debounceSaveSettings();
    },
    [debounceSaveSettings],
  );

  const handleSleepExpire = useCallback(() => {
    // PAUSE — never toggle. After a screen-off expiry, Java has already
    // paused and the queued native-tts-* events may not have synced JS state
    // yet; a toggle() based on that stale state lands in the resume branch
    // and RESTARTS the playback the timer just stopped. pausePlayback() is
    // idempotent (no-ops when already paused) and never resumes anything.
    if (isNativePlatform()) {
      try {
        getTtsBridge()?.pausePlayback();
      } catch {
        /* bridge unavailable */
      }
      return;
    }
    if (playerStateRef.current.isPlaying) playerStateRef.current.toggle();
  }, []);
  const {
    remaining: sleepRemaining,
    setTimer: setSleepTimer,
    cancelTimer: cancelSleepTimer,
  } = useSleepTimer(handleSleepExpire);

  // ── Native media controls: prev/next chapter are now handled entirely in
  // Java (TtsPlaybackService.skipToNextChapter / restartCurrentChapter) so
  // they work even when the screen is off and the WebView is suspended.
  // No JS event listener needed for these anymore.

  // Update notification title when track changes.
  // Also fires when book title loads so the notification stays current.
  useEffect(() => {
    if (!isNativePlatform() || !track?.chapter?.title) return;
    getTtsBridge()?.updateTitle(track.chapter.title);
  }, [track?.chapter?.title, track?.book?.title]);

  // Push the book cover to the native media notification / lockscreen art.
  // Fires when the book (cover) changes; "" clears any stale art.
  useEffect(() => {
    if (!isNativePlatform()) return;
    getTtsBridge()?.updateCover?.(track?.book?.cover_url ?? "");
  }, [track?.book?.cover_url]);

  // Hand Java the book id + title: the id keys its durable session snapshot
  // and its background server-progress writes; the title shows as the artist
  // line on the lockscreen / Bluetooth displays.
  useEffect(() => {
    if (!isNativePlatform() || !track?.bookId) return;
    try {
      getTtsBridge()?.setSessionInfo?.(track.bookId, track.book?.title ?? "");
    } catch {
      /* bridge unavailable */
    }
  }, [track?.bookId, track?.book?.title]);

  // ── Background-chapter override for the MiniPlayer ──
  // While the user browses other pages, native auto-advances chapters but the
  // track object (set by the listen page) goes stale — the MiniPlayer would
  // show the old chapter title at ~100% forever. After a cold start there is
  // no track AT ALL, yet audio may be playing (or a restored session sitting
  // paused). Mirror the native session into a lightweight override whenever
  // it differs from the track (or when there is no track).
  const [nativeChapterOverride, setNativeChapterOverride] = useState<{
    bookId: string;
    bookTitle: string;
    coverUrl: string;
    chapterId: string;
    title: string;
    chunkIndex: number;
    totalChunks: number;
    playing: boolean;
  } | null>(null);
  const trackChapterId = track?.chapterId ?? "";
  useEffect(() => {
    if (!isNativePlatform() || !voice.startsWith("native:")) return;
    const refresh = () => {
      const bridge = getTtsBridge();
      if (!bridge) return;
      let next: typeof nativeChapterOverride = null;
      try {
        const nativeChId = bridge.getCurrentChapterId?.() ?? "";
        if (nativeChId && nativeChId !== trackChapterId) {
          next = {
            bookId: bridge.getCurrentBookId?.() ?? "",
            bookTitle: bridge.getCurrentBookTitle?.() ?? "",
            coverUrl: bridge.getCoverUrl?.() ?? "",
            chapterId: nativeChId,
            title: bridge.getCurrentTitle?.() ?? "",
            chunkIndex: Math.max(bridge.getCurrentChunk?.() ?? 0, 0),
            totalChunks: bridge.getTotalChunks?.() ?? 0,
            playing: bridge.isPlaying?.() ?? false,
          };
        }
      } catch {
        /* bridge unavailable */
      }
      setNativeChapterOverride((prev) => {
        if (prev === null && next === null) return prev;
        if (
          prev !== null &&
          next !== null &&
          prev.bookId === next.bookId &&
          prev.bookTitle === next.bookTitle &&
          prev.coverUrl === next.coverUrl &&
          prev.chapterId === next.chapterId &&
          prev.title === next.title &&
          prev.chunkIndex === next.chunkIndex &&
          prev.totalChunks === next.totalChunks &&
          prev.playing === next.playing
        )
          return prev;
        return next;
      });
    };
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("native-tts-chapter-advance", refresh);
    window.addEventListener("native-tts-chunk", refresh);
    window.addEventListener("native-tts-state", refresh);
    document.addEventListener("visibilitychange", onVisible);
    // Service binding + snapshot restore take a moment after app start, and a
    // restored-PAUSED session emits no events — retry so it still surfaces.
    refresh();
    const t1 = setTimeout(refresh, 800);
    const t2 = setTimeout(refresh, 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("native-tts-chapter-advance", refresh);
      window.removeEventListener("native-tts-chunk", refresh);
      window.removeEventListener("native-tts-state", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [voice, trackChapterId]);

  // ── App-open reconciler: pull everything Java accumulated while the WebView
  // was suspended or dead, no matter WHICH page the app opens on. The listen
  // page has its own (richer) sync, but a cold start always lands on the home
  // page — without this, local progress pointers, the server row, and the XP
  // for chapters completed in the background would sit in Java untouched
  // until the user happens to visit /listen.
  const queryClient = useQueryClient();
  const xpDrainedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;

    const reconcile = async () => {
      const bridge = getTtsBridge();
      if (!bridge) return;
      let bookId = "";
      let chapterId = "";
      let chunkIdx = 0;
      let ts = Date.now();
      let liveSession = false;
      try {
        bookId = bridge.getCurrentBookId?.() ?? "";
        chapterId = bridge.getCurrentChapterId?.() ?? "";
        chunkIdx = Math.max(bridge.getCurrentChunk?.() ?? 0, 0);
        liveSession = !!chapterId;
        if (!chapterId) {
          // No live/restored session (e.g. user swiped the app away while
          // listening) — fall back to the durable last-position pointer.
          const raw = bridge.getLastListenPosition?.() ?? "";
          if (raw) {
            const last = JSON.parse(raw) as {
              bookId?: string;
              chapterId?: string;
              chunkIdx?: number;
              ts?: number;
            };
            bookId = last.bookId ?? "";
            chapterId = last.chapterId ?? "";
            chunkIdx = Math.max(last.chunkIdx ?? 0, 0);
            ts = last.ts ?? 0;
          }
        }
      } catch {
        return;
      }
      if (!bookId || !chapterId) return;

      // 1. Device-local pointers — synchronous, so a BookDetail mounted right
      //    after sees fresh values. Never regress a newer pointer.
      const prevTs = Number(
        localStorage.getItem(`listen-chapter-ts:${bookId}`) ?? 0,
      );
      if (ts >= prevTs) {
        localStorage.setItem(`listen-chapter:${bookId}`, chapterId);
        localStorage.setItem(`listen-chapter-ts:${bookId}`, String(ts));
      }
      saveLocalProgress({
        book_id: bookId,
        chapter_id: chapterId,
        progress_value: chunkIdx,
      });

      // 2. Chapter metadata: index for book-level progress, word_count for XP.
      //    Shares the listen page's query cache; offline falls back to the
      //    IndexedDB snapshot.
      let chapters: Chapter[] = [];
      try {
        const data = await queryClient.fetchQuery({
          queryKey: ["chapters", bookId, "all"],
          queryFn: () => api.getAllBookChapters(bookId),
          staleTime: 60_000,
        });
        chapters = data?.items ?? [];
      } catch {
        const cached = await getCachedAllChapters(bookId).catch(() => null);
        chapters = cached?.items ?? [];
      }
      if (cancelled) return;
      const ch = chapters.find((c) => c.id === chapterId);
      if (ch) {
        saveLocalBookProgress({
          book_id: bookId,
          chapter_id: chapterId,
          chapter_index: ch.chapter_index,
          progress_value: chunkIdx,
        });
      }

      if (!isLoggedIn()) return;
      // 3. Server: push the position. Matters most after a process kill —
      //    Java's own background PUTs stop then (the token is never persisted).
      syncBookProgressToServer(bookId).catch(() => {});
      // 4. XP for chapters completed while JS was suspended/dead. word_count
      //    is REQUIRED for correct XP and the backend dedupes the FIRST
      //    submission — so only drain (which clears Java's list) once the
      //    chapter list is actually available.
      if (liveSession && chapters.length > 0) {
        try {
          const ids = JSON.parse(bridge.getCompletedChapterIds()) as string[];
          ids.forEach((completedId) => {
            if (xpDrainedRef.current.has(completedId)) return;
            xpDrainedRef.current.add(completedId);
            const cc = chapters.find((c) => c.id === completedId);
            api
              .completeChapter({
                chapter_id: completedId,
                book_id: bookId,
                mode: "listen",
                word_count: cc?.word_count ?? 0,
              })
              .catch(() => {});
          });
        } catch {
          /* ignore */
        }
      }
    };

    const onVisible = () => {
      if (!document.hidden) reconcile();
    };
    // Service binding + snapshot restore take a moment after app start.
    reconcile();
    const t1 = setTimeout(reconcile, 800);
    const t2 = setTimeout(reconcile, 3000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [queryClient]);

  // Stop playback on logout. The native TTS foreground service runs in its
  // own thread and outlives clearAuth(); without this, a signed-out user keeps
  // hearing audio they have no UI to control.
  useEffect(() => {
    const handleAuthChange = () => {
      if (isLoggedIn()) return;
      const bridge = getTtsBridge();
      if (bridge) {
        try { bridge.stopPlayback(); } catch {}
        try { bridge.clearNextChapter(); } catch {}
        try { bridge.cancelSleepTimer(); } catch {}
      }
      if (playerStateRef.current.isPlaying) {
        try { playerStateRef.current.toggle(); } catch {}
      }
      releaseBackgroundLock();
      setTrackState(null);
    };
    window.addEventListener("auth-change", handleAuthChange);
    return () => window.removeEventListener("auth-change", handleAuthChange);
  }, []);

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
    nativeChapterOverride: isNativeVoice ? nativeChapterOverride : null,
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
