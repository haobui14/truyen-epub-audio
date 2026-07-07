"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { isNativePlatform } from "@/lib/capacitor";
import { splitIntoChunks } from "@/lib/textChunks";

/**
 * Browser/device TTS engine — the web counterpart of the Android native
 * player. Speaks chapter text through the Web Speech API
 * (`window.speechSynthesis`), i.e. with the voices installed on the OS:
 *
 * - Windows: "Microsoft An" (offline, once the Vietnamese language pack is
 *   installed) + Edge's online Natural voices (HoaiMy/NamMinh).
 * - Android browsers (PWA in Chrome, NOT the Capacitor APK): the device's
 *   Google TTS voices — the same ones the native app uses.
 *
 * Voice values: "browser:voice:<voiceURI>" (specific) or "browser:default"
 * (let the engine pick a vi-VN voice). The Capacitor APK never uses this
 * engine — its WebView has no speechSynthesis and the native player covers it.
 *
 * Mirrors the useSpeechPlayer contract (same return shape + chunk semantics:
 * splitIntoChunks with the default targetCount, so chunk-index progress is
 * interchangeable across all three engines). Pause is cancel-and-remember —
 * speechSynthesis.pause() is unreliable across engines — so resume re-speaks
 * the current chunk from its start, exactly like the native player.
 */

export interface BrowserVoiceOption {
  /** Player voice value: "browser:voice:<voiceURI>". */
  value: string;
  /** Label for the picker, e.g. "Microsoft An" or "HoaiMy · mạng". */
  label: string;
}

/** True when this runtime can speak through the Web Speech API. The native
 * APK is excluded even if a future WebView adds support — device voices there
 * belong to the native engine, which survives screen-off. */
export function browserTTSSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function" &&
    !isNativePlatform()
  );
}

function listViVoices(): SpeechSynthesisVoice[] {
  try {
    return window.speechSynthesis
      .getVoices()
      .filter((v) =>
        (v.lang ?? "").toLowerCase().replace("_", "-").startsWith("vi"),
      );
  } catch {
    return [];
  }
}

/** Preferred fallback when no specific voice is picked or the picked one
 * disappeared (e.g. language pack removed): first offline vi voice, else any. */
function pickDefaultViVoice(): SpeechSynthesisVoice | null {
  const vi = listViVoices();
  return vi.find((v) => v.localService) ?? vi[0] ?? null;
}

function resolveVoice(value: string | null | undefined): SpeechSynthesisVoice | null {
  if (!value?.startsWith("browser:voice:")) return pickDefaultViVoice();
  const id = value.slice("browser:voice:".length);
  const all = window.speechSynthesis.getVoices();
  return (
    all.find((v) => v.voiceURI === id) ??
    all.find((v) => v.name === id) ??
    pickDefaultViVoice()
  );
}

/** "Microsoft An - Vietnamese (Vietnam)" → "Microsoft An"; network voices get
 * the same "· mạng" suffix as the Android picker. */
function browserVoiceLabel(v: SpeechSynthesisVoice, ordinal: number): string {
  let label = v.name
    .replace(/\s*[-–—(]\s*(Vietnamese|Tiếng Việt|vi[-_]VN).*$/i, "")
    .replace(/\s*\(Natural\)\s*/gi, " ")
    .replace(/\bOnline\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!label) label = `Giọng ${ordinal}`;
  return v.localService ? label : `${label} · mạng`;
}

/**
 * Vietnamese voices available to the Web Speech API, for the voice picker.
 * Empty on the native APK / unsupported browsers / machines with no vi voice
 * (the picker section hides itself then). Voices load asynchronously — some
 * engines (Edge's online voices) arrive in a second wave, so the
 * `voiceschanged` listener stays registered.
 */
export function useBrowserTTSVoices(): BrowserVoiceOption[] {
  const [voices, setVoices] = useState<BrowserVoiceOption[]>([]);

  useEffect(() => {
    if (!browserTTSSupported()) return;
    let cancelled = false;
    const load = () => {
      if (cancelled) return;
      const vi = listViVoices();
      if (vi.length === 0) return;
      // Offline (local) voices first, then stable by name — mirrors the
      // Android picker's ordering.
      vi.sort(
        (a, b) =>
          Number(!a.localService) - Number(!b.localService) ||
          a.name.localeCompare(b.name),
      );
      const next = vi.map((v, i) => ({
        value: `browser:voice:${v.voiceURI}`,
        label: browserVoiceLabel(v, i + 1),
      }));
      setVoices((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    // Some engines never fire voiceschanged when the list was ready at page
    // load but empty at OUR first call — cover the gap with delayed retries.
    const t1 = setTimeout(load, 500);
    const t2 = setTimeout(load, 2000);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      window.speechSynthesis.removeEventListener?.("voiceschanged", load);
    };
  }, []);

  return voices;
}

export function useBrowserTTSPlayer(
  bookId: string,
  chapterId: string,
  text: string | null | undefined,
  voiceName: string | null,
  onEnded?: (nativeChapterId?: string) => void,
  autoPlay?: boolean,
  initialChunkIndex?: number,
) {
  const isActive = !!voiceName?.startsWith("browser:");

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [rate, setRateState] = useState(1);
  const [pitch, setPitchState] = useState(1);

  const chunksRef = useRef<string[]>([]);
  const chunkRef = useRef(0);
  const stoppedRef = useRef(true);
  const rateRef = useRef(1);
  const pitchRef = useRef(1);
  const voiceNameRef = useRef(voiceName);
  voiceNameRef.current = voiceName;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // Monotonic token: every cancel/restart bumps it, and utterance callbacks
  // compare against it. cancel() fires end/error events ASYNCHRONOUSLY in some
  // engines — without the token an old utterance's onend would chain-speak the
  // next chunk of a chapter we already left.
  const speakTokenRef = useRef(0);
  // Chrome garbage-collects utterances that JS no longer references, and a
  // collected utterance never fires onend (playback silently stalls at the
  // end of a chunk). Pin the live one.
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // speakChunk via ref to avoid stale closures in the onend chain
  // (same pattern as useSpeechPlayer's playChunkRef).
  const speakChunkRef = useRef<(index: number) => void>(null!);
  speakChunkRef.current = (index: number) => {
    if (!browserTTSSupported() || stoppedRef.current) return;
    if (index >= chunksRef.current.length) return;
    const token = ++speakTokenRef.current;
    const synth = window.speechSynthesis;
    synth.cancel();

    const u = new SpeechSynthesisUtterance(chunksRef.current[index]);
    const v = resolveVoice(voiceNameRef.current);
    if (v) u.voice = v;
    u.lang = v?.lang ?? "vi-VN";
    u.rate = Math.max(0.1, Math.min(rateRef.current, 10));
    u.pitch = Math.max(0, Math.min(pitchRef.current, 2));

    u.onstart = () => {
      if (token !== speakTokenRef.current) return;
      setIsBuffering(false);
    };
    u.onend = () => {
      if (token !== speakTokenRef.current || stoppedRef.current) return;
      const next = index + 1;
      if (next >= chunksRef.current.length) {
        // Chapter finished — mirror useSpeechPlayer's streaming done path.
        stoppedRef.current = true;
        setIsPlaying(false);
        setIsBuffering(false);
        setChunkIndex(0);
        chunkRef.current = 0;
        onEndedRef.current?.();
      } else {
        setChunkIndex(next);
        chunkRef.current = next;
        speakChunkRef.current(next);
      }
    };
    u.onerror = (e) => {
      if (token !== speakTokenRef.current || stoppedRef.current) return;
      // Our own cancel() surfaces as interrupted/canceled — the token guard
      // usually filters those, but engines differ; never treat them as fatal.
      if (e.error === "interrupted" || e.error === "canceled") return;
      // Real failure (not-allowed without user gesture, synthesis-failed,
      // network error on an online voice, ...) — stop cleanly; the play
      // button restarts from the current chunk.
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
    };

    utteranceRef.current = u;
    setChunkIndex(index);
    chunkRef.current = index;
    // Online voices (Edge Natural) have noticeable synth latency — show the
    // buffering spinner until onstart. Local voices clear it within ~a frame.
    setIsBuffering(true);
    synth.speak(u);
  };

  // Chrome (desktop Chromium) stops speaking mid-utterance after ~15s of
  // continuous audio unless nudged with pause()+resume(). Our chunks average
  // chapterLength/20 chars, easily >15s of speech, so keep a heartbeat while
  // active. Skipped on Android browsers, where pause/resume is itself the
  // flaky part and the 15s bug doesn't exist (OS engine does the speaking).
  useEffect(() => {
    if (!isActive || !browserTTSSupported()) return;
    const ua = navigator.userAgent;
    if (/android/i.test(ua) || !/chrome|edg/i.test(ua)) return;
    const id = setInterval(() => {
      const synth = window.speechSynthesis;
      if (!stoppedRef.current && synth.speaking && !synth.paused) {
        synth.pause();
        synth.resume();
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [isActive]);

  // Reset when chapter / text / active state changes
  useEffect(() => {
    speakTokenRef.current++;
    if (browserTTSSupported()) window.speechSynthesis.cancel();
    stoppedRef.current = true;
    setIsPlaying(false);
    setIsBuffering(false);

    if (!isActive || !text) {
      chunksRef.current = [];
      setTotalChunks(0);
      setChunkIndex(0);
      chunkRef.current = 0;
      return;
    }

    chunksRef.current = splitIntoChunks(text);
    setTotalChunks(chunksRef.current.length);
    const maxIdx = chunksRef.current.length - 1;
    const startIdx =
      maxIdx >= 0 ? Math.min(Math.max(initialChunkIndex ?? 0, 0), maxIdx) : 0;
    setChunkIndex(startIdx);
    chunkRef.current = startIdx;

    if (autoPlay && chunksRef.current.length > 0) {
      // Auto-advance / SPA navigation keeps the page's user activation, so
      // speak() is allowed. On a truly cold ?autoplay=1 load the engine
      // rejects with "not-allowed" and onerror parks us paused — same UX as
      // the audio-element autoplay policy on the web player.
      stoppedRef.current = false;
      setIsPlaying(true);
      speakChunkRef.current(startIdx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, text, isActive]);

  // When initialChunkIndex arrives late (async progress load), apply it if
  // playback hasn't started — same contract as the other two engines.
  useEffect(() => {
    if (
      !stoppedRef.current ||
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

  // Mid-playback browser→browser voice switch: re-speak the current chunk so
  // the new voice is heard immediately (the voice is resolved per utterance).
  // The prev-ref keeps a plain mount from restarting anything — mirrors the
  // native player's voice effect.
  const prevVoiceRef = useRef(voiceName);
  useEffect(() => {
    const prev = prevVoiceRef.current;
    prevVoiceRef.current = voiceName;
    if (!isActive) return;
    if (prev !== voiceName && !stoppedRef.current && chunksRef.current.length > 0) {
      speakChunkRef.current(chunkRef.current);
    }
  }, [isActive, voiceName]);

  // Some engines silently stop while the tab is hidden. On return, if JS
  // thinks it's playing but nothing is speaking, re-enter the chunk loop —
  // mirrors useSpeechPlayer's screen-on recovery.
  useEffect(() => {
    if (!isActive) return;
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (!browserTTSSupported() || stoppedRef.current) return;
      const synth = window.speechSynthesis;
      if (synth.paused) {
        synth.resume();
      } else if (!synth.speaking && !synth.pending) {
        speakChunkRef.current(chunkRef.current);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [isActive]);

  // Cleanup on unmount (the provider lives in the root layout, so this mostly
  // matters for hot reload — but never leave the engine speaking unowned).
  useEffect(
    () => () => {
      speakTokenRef.current++;
      if (browserTTSSupported()) window.speechSynthesis.cancel();
    },
    [],
  );

  const toggle = useCallback(() => {
    if (!isActive || !browserTTSSupported()) return;
    if (!stoppedRef.current) {
      // Pause = cancel + remember the chunk. speechSynthesis.pause() wedges on
      // several engines; resuming from the top of the current sentence is the
      // same behaviour the native player has.
      speakTokenRef.current++;
      window.speechSynthesis.cancel();
      stoppedRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
    } else {
      if (!chunksRef.current.length) return;
      stoppedRef.current = false;
      setIsPlaying(true);
      speakChunkRef.current(chunkRef.current);
    }
  }, [isActive]);

  const changeRate = useCallback((newRate: number) => {
    rateRef.current = newRate;
    setRateState(newRate);
    // Utterance params are fixed at speak() time — restart the current chunk
    // so the new rate is heard immediately.
    if (!stoppedRef.current && chunksRef.current.length > 0) {
      speakChunkRef.current(chunkRef.current);
    }
  }, []);

  const changePitch = useCallback((newPitch: number) => {
    pitchRef.current = newPitch;
    setPitchState(newPitch);
    if (!stoppedRef.current && chunksRef.current.length > 0) {
      speakChunkRef.current(chunkRef.current);
    }
  }, []);

  const restartChunk = useCallback(() => {
    if (!isActive) return;
    if (!stoppedRef.current && chunksRef.current.length > 0) {
      speakChunkRef.current(chunkRef.current);
    }
  }, [isActive]);

  const seekChunk = useCallback((delta: number) => {
    const maxIdx = chunksRef.current.length - 1;
    if (maxIdx < 0) return;
    const idx = Math.max(
      0,
      Math.min(Math.round(chunkRef.current + delta), maxIdx),
    );
    if (idx === chunkRef.current && Math.round(delta) === 0) return;

    setChunkIndex(idx);
    chunkRef.current = idx;
    if (!stoppedRef.current) speakChunkRef.current(idx);
  }, []);

  const progress =
    totalChunks > 0 ? Math.max(0, Math.min(1, chunkIndex / totalChunks)) : 0;

  return {
    isPlaying: isPlaying || isBuffering,
    isBuffering,
    // Local voices are the point of this engine — never show the offline
    // warning banner for it. Online voices fail per-utterance instead.
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
  };
}
