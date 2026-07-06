"use client";
import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Sleep timer backed by an absolute expiry timestamp (Date.now() + duration).
 *
 * Why not setInterval/setTimeout for countdown?
 * On Android (and browsers with throttled background tabs) JavaScript timers
 * are suspended when the screen turns off.  Storing an absolute "expire at"
 * timestamp lets us recalculate remaining time correctly the moment the screen
 * comes back on via the visibilitychange event.
 *
 * The native Android TTS service is also notified so it can stop playback
 * purely in Java when the WebView is fully suspended (screen off).
 */
export function useSleepTimer(onExpire: () => void) {
  // Absolute epoch-ms when the timer should fire; null = not active.
  const [expireAt, setExpireAt] = useState<number | null>(null);
  // Derived remaining seconds shown in the UI.
  const [remaining, setRemaining] = useState<number | null>(null);
  // "Hết chương" mode: the native service pauses at the next chapter
  // boundary (no countdown to show). Mutually exclusive with expireAt.
  const [endOfChapter, setEndOfChapter] = useState(false);

  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // Guards against firing onExpire twice for one timer — the 1s tick and the
  // visibilitychange handler can both observe expiry in the same instant
  // (setExpireAt(null) is async), which would pause+advance unexpectedly.
  const firedRef = useRef(false);

  // Helper: tell the native Android service about the timer so it can fire
  // even when the WebView (and JS timers) are suspended by the OS.
  const notifyNative = useCallback((expMs: number | null) => {
    try {
      const bridge = (window as unknown as {
        TtsBridge?: {
          setSleepTimer?: (ms: number) => void;
          cancelSleepTimer?: () => void;
        };
      }).TtsBridge;
      if (expMs === null) {
        bridge?.cancelSleepTimer?.();
      } else {
        bridge?.setSleepTimer?.(expMs);
      }
    } catch {
      /* not on Android — ignore */
    }
  }, []);

  const notifyNativeChapterEnd = useCallback((on: boolean) => {
    try {
      const bridge = (window as unknown as {
        TtsBridge?: { setSleepAtChapterEnd?: (on: boolean) => void };
      }).TtsBridge;
      bridge?.setSleepAtChapterEnd?.(on);
    } catch {
      /* not on Android — ignore */
    }
  }, []);

  // Tick every second and check if expired.
  useEffect(() => {
    if (expireAt === null) {
      setRemaining(null);
      return;
    }

    const tick = () => {
      const left = Math.ceil((expireAt - Date.now()) / 1000);
      if (left <= 0) {
        setExpireAt(null);
        setRemaining(null);
        if (!firedRef.current) {
          firedRef.current = true;
          onExpireRef.current();
        }
      } else {
        setRemaining(left);
      }
    };

    // Run immediately so the display is correct right away (also handles
    // the case where we just came back from a screen-off event and the
    // timer has already elapsed).
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expireAt]);

  // When the screen turns back on, immediately check whether the timer
  // has elapsed — because setInterval was throttled/suspended while off.
  useEffect(() => {
    if (expireAt === null) return;

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() >= expireAt) {
        setExpireAt(null);
        setRemaining(null);
        if (!firedRef.current) {
          firedRef.current = true;
          onExpireRef.current();
        }
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [expireAt]);

  // "Hết chương" mode ends when Java fires native-tts-done {sleep:true} at
  // the chapter boundary — clear the UI state so the chip stops showing an
  // armed timer.
  useEffect(() => {
    if (!endOfChapter) return;
    const onDone = (e: Event) => {
      if ((e as CustomEvent<{ sleep?: boolean }>).detail?.sleep) {
        setEndOfChapter(false);
      }
    };
    window.addEventListener("native-tts-done", onDone);
    return () => window.removeEventListener("native-tts-done", onDone);
  }, [endOfChapter]);

  const setTimer = useCallback(
    (minutes: number) => {
      const exp = Date.now() + Math.max(0.016, minutes) * 60 * 1000;
      firedRef.current = false; // arm a fresh timer
      setEndOfChapter(false); // timed mode replaces chapter-end mode
      notifyNativeChapterEnd(false);
      setExpireAt(exp);
      notifyNative(exp);
    },
    [notifyNative, notifyNativeChapterEnd],
  );

  /** Arm "sleep when the current chapter ends" (native platforms only). */
  const setChapterEndTimer = useCallback(() => {
    setExpireAt(null);
    setRemaining(null);
    notifyNative(null); // chapter-end mode replaces any timed mode
    setEndOfChapter(true);
    notifyNativeChapterEnd(true);
  }, [notifyNative, notifyNativeChapterEnd]);

  const cancelTimer = useCallback(() => {
    setExpireAt(null);
    setRemaining(null);
    notifyNative(null);
    setEndOfChapter(false);
    notifyNativeChapterEnd(false);
  }, [notifyNative, notifyNativeChapterEnd]);

  return { remaining, endOfChapter, setTimer, setChapterEndTimer, cancelTimer };
}
