"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { isNativePlatform } from "@/lib/capacitor";
import {
  acquireBackgroundLock,
  releaseBackgroundLock,
  getTtsBridge,
} from "@/lib/backgroundLock";
import { splitIntoChunks } from "@/lib/textChunks";

export interface NativeVoiceOption {
  /** Player voice value: "native:vi-VN-default" or "native:voice:<name>". */
  value: string;
  /** Label for the picker, e.g. "Giọng nữ 1 · mạng". */
  label: string;
}

/** Best-effort friendly label — Google voice names encode gender as vif/vim. */
function nativeVoiceLabel(name: string, network: boolean, ordinal: number) {
  const lower = name.toLowerCase();
  let base = `Giọng ${ordinal}`;
  // "female" first — it contains "male" as a substring.
  if (lower.includes("female") || lower.includes("vif")) {
    base = `Giọng nữ ${ordinal}`;
  } else if (lower.includes("male") || lower.includes("vim")) {
    base = `Giọng nam ${ordinal}`;
  }
  return network ? `${base} · mạng` : base;
}

/** "native:voice:<name>" → "<name>"; anything else → "" (engine default). */
function deviceVoiceFromValue(v: string | null | undefined): string {
  return v?.startsWith("native:voice:")
    ? v.slice("native:voice:".length)
    : "";
}

/**
 * Device TTS voices for the native voice picker. Always contains the engine
 * default; fills with the device's installed Vietnamese voices once the TTS
 * engine reports them (the service initialises ~1 s after app start, so a
 * couple of delayed retries cover the cold-start window).
 */
export function useNativeTTSVoices(): NativeVoiceOption[] {
  const [voices, setVoices] = useState<NativeVoiceOption[]>(() =>
    isNativePlatform()
      ? [{ value: "native:vi-VN-default", label: "Hệ thống (mặc định)" }]
      : [],
  );

  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    const load = (): boolean => {
      const bridge = getTtsBridge();
      // Old APK without the voice catalogue — nothing to retry for.
      if (typeof bridge?.getNativeVoices !== "function") return true;
      let parsed: { name?: string; quality?: number; network?: boolean }[];
      try {
        parsed = JSON.parse(bridge.getNativeVoices());
      } catch {
        return false;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      // Local (offline) voices first, then stable by name.
      parsed.sort(
        (a, b) =>
          Number(a.network ?? false) - Number(b.network ?? false) ||
          (a.name ?? "").localeCompare(b.name ?? ""),
      );
      const opts: NativeVoiceOption[] = [
        { value: "native:vi-VN-default", label: "Hệ thống (mặc định)" },
      ];
      let ordinal = 0;
      for (const v of parsed) {
        if (!v.name) continue;
        ordinal += 1;
        opts.push({
          value: `native:voice:${v.name}`,
          label: nativeVoiceLabel(v.name, v.network ?? false, ordinal),
        });
      }
      if (!cancelled && opts.length > 1) setVoices(opts);
      return opts.length > 1;
    };
    if (load()) return;
    const t1 = setTimeout(load, 1500);
    const t2 = setTimeout(load, 5000);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return voices;
}

/**
 * Whether native TTS is available on this device.
 */
export function useNativeTTSAvailable() {
  return useState(() => isNativePlatform())[0];
}

/**
 * Plays book chapter text using the device's native TTS engine via the
 * Android TtsPlaybackService. The chunk loop runs entirely in Java so
 * playback continues when the WebView is suspended (screen off).
 *
 * ## Responsibilities
 * 1. Push chunks to native (`startNativePlayback` → `bridge.playChunksWithId`).
 * 2. Listen to `native-tts-*` events and sync JS state (`isPlaying`,
 *    `chunkIndex`, `ttsError`) + call `onEnded` for chapter advance / done.
 * 3. Reset appropriately when `chapterId` / `text` / `isActive` changes —
 *    see the reset effect's four-way branch (invariants I4, I5).
 *
 * ## Native events handled
 * | Event                       | Handler             | Action                            |
 * |-----------------------------|---------------------|-----------------------------------|
 * | `native-tts-chunk`          | `onChunk`           | setChunkIndex if on this chapter |
 * | `native-tts-state`          | `onState`           | Sync isPlaying, chunkIndex        |
 * | `native-tts-chapter-advance`| `onChapterAdvance`  | dedup + `onEnded(newChapterId)`   |
 * | `native-tts-done`           | `onDone`            | clear state, maybe release lock   |
 * | `native-tts-error`          | `onNativeError`     | setTtsError                       |
 *
 * ## Coordination refs (none is purely cosmetic)
 * - `chapterAdvancedRef` — set by `onChapterAdvance`, read by reset effect
 *   to preserve native playback during auto-advance-triggered route change.
 * - `lastAdvancedChapterRef` — dedup for batched advance events on WebView
 *   resume (all queued events fire in one microtask).
 * - `chapterIdRef`, `chapterTitleRef`, `chunksRef`, `chunkRef`, `playingRef`,
 *   `rateRef`, `pitchRef`, `onEndedRef` — mirror of React state/props for
 *   use inside stable callbacks.
 *
 * See `docs/android-player.md` for the full state machine, invariants, and
 * navigation flow map.
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
  // Which chapter chunksRef's contents belong to. After an auto-advance this
  // hook sits on the NEW chapterId while chunksRef still holds the LAST
  // LOADED chapter's text until the new text query resolves — and screen-off
  // advances load nothing, so that can be many chapters back. Pushing those
  // chunks under the new chapterId would make Java speak the old chapter
  // labeled with the new chapter's id/title (UI says ch.9, ears hear ch.5).
  const chunksChapterIdRef = useRef<string | null>(null);
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

  // Coalesces bursts of chapter-advance events with DISTINCT chapter IDs
  // (A→B→C, queued while the screen was off, all flushed on resume). The
  // dedup ref above only catches repeats of the SAME ID — without this timer
  // each distinct ID would router.push, piling up history entries and
  // re-seeding Java's playlist once per skipped chapter.
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chapterIdRef = useRef(chapterId);
  chapterIdRef.current = chapterId;
  const chapterTitleRef = useRef(chapterTitle);
  chapterTitleRef.current = chapterTitle;
  const voiceNameRef = useRef(voiceName);
  voiceNameRef.current = voiceName;

  // Send chunks to native and start playback
  const startNativePlayback = useCallback((startIdx: number) => {
    const bridge = getTtsBridge();
    if (!bridge || chunksRef.current.length === 0) return;
    if (chunksChapterIdRef.current !== chapterIdRef.current) {
      // Stale text: the chunks in memory belong to a different chapter than
      // the one this hook is on (new chapter's text still loading after an
      // advance). Pushing them would poison Java's session — and its persisted
      // snapshot — with old content under the new chapter id. Skip; rate/
      // pitch/voice changes still apply from the next utterance via their
      // bridge setters, and playback starts normally once the text arrives.
      setIsBuffering(false);
      return;
    }

    // Clamp to valid range — guards against stale progress saved in a
    // different unit (e.g. seconds from web-audio mode vs chunk index).
    const safeIdx = Math.max(0, Math.min(startIdx, chunksRef.current.length - 1));
    const chunksJson = JSON.stringify(chunksRef.current);
    const notifTitle = chapterTitleRef.current ?? "Đang phát...";
    try {
      // Make sure Java speaks with the picked device voice — playback starts
      // are the authoritative re-seed point (survives service restarts).
      try {
        bridge.setNativeVoice?.(deviceVoiceFromValue(voiceNameRef.current));
      } catch {
        /* older APK */
      }
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

  // Re-speak the chunk that is audibly playing so a rate/pitch/voice change
  // is heard immediately. Prefers an in-place Java-side re-speak via
  // seekToChunk: it uses Java's OWN chunks (content-correct even while this
  // hook's text is still loading after an auto-advance) and leaves Java's
  // queue/prefetch chain intact — a playChunks restart clears both. Falls
  // back to a guarded full push for older APKs without seekToChunk.
  const respeakCurrentChunk = useCallback(() => {
    const bridge = getTtsBridge();
    if (!bridge) return;
    try {
      const idx = bridge.getCurrentChunk?.() ?? -1;
      if (
        typeof bridge.seekToChunk === "function" &&
        idx >= 0 &&
        (bridge.getCurrentChapterId?.() ?? "") === chapterIdRef.current
      ) {
        bridge.seekToChunk(idx);
        return;
      }
    } catch {
      /* fall through to the full restart */
    }
    startNativePlayback(chunkRef.current);
  }, [startNativePlayback]);

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

      // Coalesce burst navigation: wait one tick and only navigate to the
      // FINAL chapter of the burst. A lone advance (the normal screen-on case)
      // just navigates 60 ms later — imperceptible.
      const target = resolvedChId;
      if (advanceTimerRef.current != null) clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = setTimeout(() => {
        advanceTimerRef.current = null;
        // JS may already be on the target (visibilitychange sync replaced the
        // URL first) — navigating again would be a redundant history entry.
        if (target && target === chapterIdRef.current) return;
        onEndedRef.current?.(target);
      }, 60);
    };

    const onDone = (e: Event) => {
      // Playback is over — a pending coalesced advance navigation would
      // re-trigger autoplay on a chapter that already finished. Cancel it.
      if (advanceTimerRef.current != null) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }

      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);

      // Sleep-timer stop: Java paused mid-chapter and dispatched done with
      // detail.sleep. Update the playing state but do NOT treat it as chapter
      // completion — calling onEnded here would auto-advance to the next
      // chapter with autoplay, restarting the playback the timer just stopped.
      // chunkIndex is kept so resume continues from the same spot.
      if ((e as CustomEvent<{ sleep?: boolean }>).detail?.sleep) {
        chapterAdvancedRef.current = false;
        // On the last chapter (no onEnded) playback can't continue anyway —
        // release the KeepAwake lock like the natural-done path does, or the
        // screen stays forced-on all night after a sleep stop.
        if (!onEndedRef.current) releaseBackgroundLock();
        return;
      }

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
      // Only sync state if native is still on this JS chapter. When JS has no
      // chapter at all (cold start, MiniPlayer driving a trackless session),
      // there is nothing to protect — accept the event so isPlaying is honest.
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      if (nativeChId && chapterIdRef.current && nativeChId !== chapterIdRef.current)
        return;

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
      // Defense in depth: ensure the service tears down so a CPU wake lock
      // acquired before a failed TTS init can't leak and drain the battery.
      try {
        getTtsBridge()?.stopPlayback();
      } catch {}
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
      if (advanceTimerRef.current != null) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  }, [isActive]);

  // Reset when chapter / text / active state changes
  useEffect(() => {
    setTtsError(null);

    const wasAutoAdvanced = chapterAdvancedRef.current;

    // Reset deduplication on every chapter change so the next chapter's
    // advance events are not accidentally suppressed.
    lastAdvancedChapterRef.current = undefined;

    // Decide whether to stop native at this chapter transition. There are four
    // possible native states at this point — only one warrants stopping.
    // See docs/android-player.md invariants I4, I5. Stale-session (I6) is
    // handled separately by ListenPageClient's stale-session guard effect.
    if (isActive && !wasAutoAdvanced) {
      const bridge = getTtsBridge();
      const nativeChId = bridge?.getCurrentChapterId?.() ?? "";
      const nativePlaying = bridge?.isPlaying?.() ?? false;

      const nativeAlreadyPlaying =
        nativeChId === chapterId && nativePlaying;
      const nativeIsAhead =
        nativePlaying && nativeChId !== "" && nativeChId !== chapterId;

      if (nativeAlreadyPlaying) {
        // I4 (lockscreen-resume): native is on THIS chapter and playing.
        // visibilitychange / cold-start just synced JS here; stopping would
        // cause the autoPlay branch below to restart from chunk 0.
      } else if (nativeIsAhead) {
        // I5 (cascade-catches-up): native advanced further than JS in the
        // tiny race between visibilitychange's router.replace and this
        // effect. Queued native-tts-chapter-advance events will catch JS up.
        // A stale-session variant of this (native playing a long-dead
        // chapter) is caught earlier by ListenPageClient's stale-session
        // guard — by the time we reach this effect, nativeIsAhead means a
        // legitimate cascade.
      } else if (nativeChId === chapterId && !nativePlaying) {
        // Same chapter, paused: a session restored after a process kill (cold
        // -start sync just replaced the URL to it, without autoplay) or a
        // notification pause. Keep it — stopPlayback() would wipe the native
        // resume position AND its persisted snapshot; toggle() resumes it in
        // place via resumePlayback().
      } else if (chapterId) {
        // Normal fresh-start path: native idle, or was on same chapter but
        // paused. Stop to clear any stale state; autoPlay branch starts fresh.
        bridge?.stopPlayback();
      }
      // chapterId empty (app launch, no track yet): leave native alone — a
      // session restored after a process kill is sitting there paused, and
      // stopping it would wipe the resume position before cold-start sync and
      // "continue listening" can read it.
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
        chunksChapterIdRef.current = null;
        setTotalChunks(0);
      }
      return;
    }

    // Text is available — split chunks for progress tracking
    chunksRef.current = splitIntoChunks(text);
    chunksChapterIdRef.current = chapterId;
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

  // Apply the picked device voice to Java. On a mid-playback native→native
  // switch, restart the current chunk so the new voice is heard immediately
  // (setNativeVoice itself only takes effect on the next utterance). The
  // prev-ref keeps a plain mount (voice unchanged) from restarting anything.
  const prevVoiceRef = useRef(voiceName);
  useEffect(() => {
    const prev = prevVoiceRef.current;
    prevVoiceRef.current = voiceName;
    if (!isActive) return;
    const bridge = getTtsBridge();
    if (!bridge) return;
    try {
      bridge.setNativeVoice?.(deviceVoiceFromValue(voiceName));
    } catch {
      /* older APK */
    }
    if (prev !== voiceName && playingRef.current) {
      respeakCurrentChunk();
    }
  }, [isActive, voiceName, respeakCurrentChunk]);

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

    // Sync JS state with native before acting — both directions. JS-thinks-
    // playing/native-isn't: playChunksWithId was silently dropped (service not
    // bound yet) — first tap must START, not pause. JS-thinks-paused/native-
    // playing: native advanced chapters in the background while the user was
    // off /listen — the tap must PAUSE what's audibly playing, not "resume"
    // (which would restart the current chunk mid-sentence).
    const nativePlaying = bridge.isPlaying();
    if (playingRef.current !== nativePlaying) {
      playingRef.current = nativePlaying;
      setIsPlaying(nativePlaying);
      setIsBuffering(false);
    }

    if (playingRef.current) {
      bridge.pausePlayback();
      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
    } else {
      // Resume whatever session native holds FIRST — its chunks in memory, or
      // a snapshot restored after a process kill (Java self-fetches the text).
      // This must not require JS chunks: after a cold start the MiniPlayer can
      // resume the native session before any page has loaded a track.
      if (bridge.getCurrentChunk() >= 0) {
        bridge.resumePlayback();
        playingRef.current = true;
        setIsPlaying(true);
      } else {
        if (!chunksRef.current.length) return;
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
      // If currently playing, re-speak the current chunk so the new rate is
      // heard immediately (Java applies it per utterance).
      if (playingRef.current) respeakCurrentChunk();
    },
    [respeakCurrentChunk],
  );

  const changePitch = useCallback(
    (newPitch: number) => {
      pitchRef.current = newPitch;
      setPitchState(newPitch);
      getTtsBridge()?.setPitch(newPitch);
      if (playingRef.current) respeakCurrentChunk();
    },
    [respeakCurrentChunk],
  );

  const restartChunk = useCallback(() => {
    if (!isActive) return;
    if (playingRef.current) respeakCurrentChunk();
  }, [isActive, respeakCurrentChunk]);

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
        const bridge = getTtsBridge();
        // Fast path: jump inside the playing chapter without the playChunks
        // restart (which clears Java's queue and prefetch chain — historically
        // the source of the wrong-chapter-jump class of bugs). Falls back for
        // older APKs or when native is on a different chapter.
        if (
          typeof bridge?.seekToChunk === "function" &&
          (bridge.getCurrentChapterId?.() ?? "") === chapterIdRef.current
        ) {
          try {
            bridge.seekToChunk(idx);
            return;
          } catch {
            /* fall through to the full restart */
          }
        }
        startNativePlayback(idx);
      }
    },
    [startNativePlayback],
  );

  const progress =
    totalChunks > 0 ? Math.max(0, Math.min(1, chunkIndex / totalChunks)) : 0;

  // Lets the error banner's "retry" button re-enable the play button after the
  // user fixes the missing voice (the play button is disabled while ttsError
  // is set, so toggle() can't clear it on its own).
  const clearTtsError = useCallback(() => setTtsError(null), []);

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
    clearTtsError,
  };
}
