"use client";
import { isNativePlatform } from "@/lib/capacitor";

interface TtsBridgeNative {
  startService(): void;
  stopService(): void;
  playChunks(chunksJson: string, rate: number, pitch: number, startIdx: number, title: string): void;
  playChunksWithId(chunksJson: string, rate: number, pitch: number, startIdx: number, title: string, chapterId: string): void;
  pausePlayback(): void;
  resumePlayback(): void;
  stopPlayback(): void;
  setRate(rate: number): void;
  setPitch(pitch: number): void;
  updateTitle(title: string): void;
  getCurrentChunk(): number;
  getCurrentChapterId(): string;
  isPlaying(): boolean;
  /** Queue next chapter for seamless background auto-advance. */
  queueNextChapter(chunksJson: string, chapterId: string, title: string, rate: number, pitch: number): void;
  /** Queue ALL remaining chapters at once for continuous background playback. */
  queueAllChapters(chaptersJson: string): void;
  /**
   * Like queueAllChapters but uses mergeQueue() — never clears the currently
   * playing chapter entry, so there is no empty-queue race window. Use for
   * incremental queue updates while playback is already in progress.
   */
  mergeQueuedChapters(chaptersJson: string): void;
  clearNextChapter(): void;
  /** Set sleep timer to fire at an absolute epoch-ms timestamp (screen-off safe). */
  setSleepTimer(expireAtMs: number): void;
  /** Cancel the sleep timer. */
  cancelSleepTimer(): void;
  /**
   * Returns a JSON-encoded string array of chapter IDs that completed via
   * native auto-advance since the last call, then clears the list.
   * Use on screen-on to award XP for chapters that finished while the
   * WebView JS was throttled (screen off).
   */
  getCompletedChapterIds(): string;
}

export function getTtsBridge(): TtsBridgeNative | undefined {
  return (window as unknown as { TtsBridge?: TtsBridgeNative }).TtsBridge;
}

/** Start the Android foreground service + KeepAwake so TTS continues in bg */
export async function acquireBackgroundLock() {
  if (!isNativePlatform()) return;
  try {
    getTtsBridge()?.startService();
  } catch {
    /* best-effort */
  }
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake");
    await KeepAwake.keepAwake();
  } catch {
    /* plugin might not be installed */
  }
}

/** Release the foreground service + KeepAwake */
export async function releaseBackgroundLock() {
  if (!isNativePlatform()) return;
  try {
    getTtsBridge()?.stopService();
  } catch {
    /* best-effort */
  }
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake");
    await KeepAwake.allowSleep();
  } catch {
    /* plugin might not be installed */
  }
}
