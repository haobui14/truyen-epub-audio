"use client";
import { isNativePlatform } from "@/lib/capacitor";

interface TtsBridgeNative {
  startService(): void;
  stopService(): void;
  playChunks(chunksJson: string, rate: number, pitch: number, startIdx: number, title: string): void;
  pausePlayback(): void;
  resumePlayback(): void;
  stopPlayback(): void;
  setRate(rate: number): void;
  setPitch(pitch: number): void;
  updateTitle(title: string): void;
  getCurrentChunk(): number;
  isPlaying(): boolean;
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
