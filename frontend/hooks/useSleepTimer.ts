"use client";
import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Sleep timer: counts down from a set number of seconds and calls
 * `onExpire` when it reaches zero.
 */
export function useSleepTimer(onExpire: () => void) {
  // null = not active; number = remaining seconds
  const [remaining, setRemaining] = useState<number | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // Tick every second
  useEffect(() => {
    if (remaining === null) return;
    if (remaining <= 0) {
      onExpireRef.current();
      setRemaining(null);
      return;
    }
    const id = setTimeout(
      () => setRemaining((r) => (r !== null ? r - 1 : null)),
      1000
    );
    return () => clearTimeout(id);
  }, [remaining]);

  const setTimer = useCallback((minutes: number) => {
    setRemaining(Math.max(1, Math.round(minutes * 60)));
  }, []);

  const cancelTimer = useCallback(() => setRemaining(null), []);

  return { remaining, setTimer, cancelTimer };
}
