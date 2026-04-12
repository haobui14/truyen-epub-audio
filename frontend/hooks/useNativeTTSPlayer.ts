"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  return useMemo(
    () =>
      isNativePlatform()
        ? [{ index: 0, name: "Giọng thiết bị", lang: `${lang}-VN` }]
        : [],
    [lang],
  );
}

/**
 * Whether native TTS is available on this device.
 */
export function useNativeTTSAvailable() {
  return useState(() => isNativePlatform())[0];
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
  chapterTitle?: string,
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

  // Tracks the chapter ID we last navigated to via onChapterAdvance.
  // Used to deduplicate batched native-tts-chapter-advance events that all
  // fire at once when the WebView resumes — without this, 10 queued events
  // would each call onEnded, causing 10 redundant router.push calls.
  const lastAdvancedChapterRef = useRef<string | undefined>(undefined);

  const chapterIdRef = useRef(chapterId);
  chapterIdRef.current = chapterId;
  const chapterTitleRef = useRef(chapterTitle);
  chapterTitleRef.current = chapterTitle;

  // Send chunks to native and start playback
  const startNativePlayback = useCallback((startIdx: number) => {
    const bridge = getTtsBridge();
    if (!bridge || chunksRef.current.length === 0) return;

    // Clamp to valid range — guards against stale progress saved in a
    // different unit (e.g. seconds from web-audio mode vs chunk index).
    const safeIdx = Math.max(0, Math.min(startIdx, chunksRef.current.length - 1));
    const chunksJson = JSON.stringify(chunksRef.current);
    const notifTitle = chapterTitleRef.current ?? "Đang phát...";
    try {
      // Use playChunksWithId (sends chapterId to native) if available,
      // fall back to playChunks for older APKs that lack the new method.
      if (typeof bridge.playChunksWithId === "function") {
        bridge.playChunksWithId(
          chunksJson,
          rateRef.current,
          pitchRef.current,
          safeIdx,
          notifTitle,
          chapterIdRef.current,
        );
      } else {
        bridge.playChunks(
          chunksJson,
          rateRef.current,
          pitchRef.current,
          safeIdx,
          notifTitle,
        );
      }
      // Always call updateTitle after starting playback so the notification
      // reflects the correct chapter title even if the track didn't change
      // (e.g., user replays the same chapter, or rate/pitch was adjusted).
      bridge.updateTitle?.(notifTitle);
      playingRef.current = true;
      setIsPlaying(true);
      setIsBuffering(false);
      setChunkIndex(safeIdx);
      chunkRef.current = safeIdx;
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
    };

    const onChapterAdvance = (e: Event) => {
      // The native service auto-advanced to the queued next chapter.
      // Set a flag so the reset effect (triggered by the upcoming navigation)
      // doesn't stop the service that's already playing.
      chapterAdvancedRef.current = true;

      // Prefer the newChapterId embedded in the event — it is set by Java
      // BEFORE startChapter() mutates currentChapterId, so it is always
      // the correct navigation target even if getCurrentChapterId() is called
      // before the volatile field is written on the main thread.
      const detail = (e as CustomEvent<{
        completedChapterId?: string;
        newChapterId?: string;
      }>).detail;
      const newChId = detail?.newChapterId;

      // Fall back to the bridge only if the event was sent by an older APK
      // that doesn't include newChapterId in the detail.
      const bridge = getTtsBridge();
      const resolvedChId =
        (newChId && newChId.length > 0)
          ? newChId
          : (bridge?.getCurrentChapterId?.() ?? undefined);

      // Deduplicate: when the WebView resumes after being suspended, all queued
      // native-tts-chapter-advance events fire in a single microtask batch and
      // each may resolve the same chapter ID. Only navigate once per chapter.
      if (resolvedChId && resolvedChId === lastAdvancedChapterRef.current) return;
      lastAdvancedChapterRef.current = resolvedChId;
      onEndedRef.current?.(resolvedChId);
    };

    const onDone = () => {
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
      setChunkIndex(0);
      chunkRef.current = 0;

      // If the service auto-advanced, onChapterAdvance already called onEnded.
      // Don't call it again to avoid double navigation.
      if (!chapterAdvancedRef.current) {
        onEndedRef.current?.();
      }
      chapterAdvancedRef.current = false;

      // If there is no onEnded callback (i.e. this is the last chapter),
      // playback is truly over — release the foreground service and KeepAwake.
      // When there IS an onEnded (next chapter exists), keep the lock so the
      // service stays alive for seamless autoPlay on the next chapter.
      if (!onEndedRef.current) {
        releaseBackgroundLock();
      }
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

    const onNativeError = (e: Event) => {
      const msg = (e as CustomEvent).detail?.message ?? "Lỗi giọng đọc";
      setTtsError(msg);
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
    };

    window.addEventListener("native-tts-chunk", onChunk);
    window.addEventListener("native-tts-chapter-advance", onChapterAdvance);
    window.addEventListener("native-tts-done", onDone);
    window.addEventListener("native-tts-state", onState);
    window.addEventListener("native-tts-error", onNativeError);

    return () => {
      window.removeEventListener("native-tts-chunk", onChunk);
      window.removeEventListener(
        "native-tts-chapter-advance",
        onChapterAdvance,
      );
      window.removeEventListener("native-tts-done", onDone);
      window.removeEventListener("native-tts-state", onState);
      window.removeEventListener("native-tts-error", onNativeError);
    };
  }, [isActive]);

  // Reset when chapter / text / active state changes
  useEffect(() => {
    setTtsError(null);

    const wasAutoAdvanced = chapterAdvancedRef.current;

    // Reset deduplication on every chapter change so the next chapter's
    // advance events are not accidentally suppressed.
    lastAdvancedChapterRef.current = undefined;

    // If the native service auto-advanced to this chapter, DON'T stop it.
    // Also skip the stop if native is already playing this chapter — this
    // guards against the visibility-change router.replace racing ahead of
    // the queued native-tts-chapter-advance event (which would otherwise
    // cause wasAutoAdvanced=false → stopPlayback → startNativePlayback(0)
    // → replay from chunk 0 on lockscreen resume).
    //
    // Additionally: if native is actively playing a DIFFERENT chapter (it has
    // auto-advanced further than JS while screen was off, and the visibilitychange
    // handler navigated JS to an intermediate chapter that native already passed),
    // do NOT stop it. The next visibilitychange cycle will sync JS to wherever
    // native currently is. Stopping here would kill playback that's working fine.
    if (isActive && !wasAutoAdvanced) {
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      const nativePlaying = bridge?.isPlaying?.() ?? false;
      // Native is ahead: actively playing a chapter other than this one.
      // Let it continue — don't stop and don't restart.
      const nativeIsAhead =
        nativePlaying && nativeChId !== "" && nativeChId !== chapterId;
      if (!nativeIsAhead) {
        const nativeAlreadyPlaying = nativeChId === chapterId && nativePlaying;
        if (!nativeAlreadyPlaying) {
          bridge?.stopPlayback();
        }
      }
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
    // Clamp initialChunkIndex to valid range — guards against stale progress
    // saved in a different unit (e.g. seconds from web-audio mode vs chunk index).
    const maxIdx = chunksRef.current.length - 1;
    const startIdx = maxIdx >= 0 ? Math.min(initialChunkIndex ?? 0, maxIdx) : 0;
    setChunkIndex(startIdx);
    chunkRef.current = startIdx;

    if (autoPlay && chunksRef.current.length > 0) {
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      const nativePlaying = bridge?.isPlaying?.() ?? false;

      if (nativeChId === chapterId && nativePlaying) {
        // Native is already playing this chapter (e.g. visibility-change navigation
        // fired before the chapter-advance event) — sync JS state, don't restart.
        const idx = bridge!.getCurrentChunk();
        const safeIdx = idx >= 0 ? idx : 0;
        setChunkIndex(safeIdx);
        chunkRef.current = safeIdx;
        playingRef.current = true;
        setIsPlaying(true);
        setIsBuffering(false);
      } else if (nativePlaying && nativeChId !== "" && nativeChId !== chapterId) {
        // Native is ahead — playing a chapter JS hasn't caught up to yet.
        // Don't call startNativePlayback (it would interrupt what's playing).
        // The visibilitychange handler will navigate JS to the correct chapter.
        playingRef.current = false;
        setIsPlaying(false);
        setIsBuffering(false);
      } else {
        // Native is idle or on the same chapter but not playing — start fresh.
        setIsBuffering(true);
        acquireBackgroundLock();
        startNativePlayback(startIdx);
      }
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

    // Sync JS state with native before acting — if JS thinks we are playing
    // but the native service isn't (e.g. playChunksWithId was silently dropped
    // because the service wasn't bound yet), treat as "not playing" so the
    // user's first tap starts audio rather than incorrectly pausing.
    if (playingRef.current && !bridge.isPlaying()) {
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
    }

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

      if (playingRef.current) {
        startNativePlayback(idx);
      }
    },
    [startNativePlayback],
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
