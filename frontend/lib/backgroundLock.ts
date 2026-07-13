"use client";
import { isNativePlatform } from "@/lib/capacitor";

interface TtsBridgeNative {
  startService(): void;
  stopService(): void;
  playChunks(
    chunksJson: string,
    rate: number,
    pitch: number,
    startIdx: number,
    title: string,
  ): void;
  playChunksWithId(
    chunksJson: string,
    rate: number,
    pitch: number,
    startIdx: number,
    title: string,
    chapterId: string,
  ): void;
  pausePlayback(): void;
  resumePlayback(): void;
  stopPlayback(): void;
  setRate(rate: number): void;
  setPitch(pitch: number): void;
  /**
   * Jump to a chunk inside the currently-playing chapter WITHOUT the full
   * playChunks restart (keeps the queue + prefetch chain intact). While
   * paused it only moves the resume position. (Optional — newer APKs.)
   */
  seekToChunk?(idx: number): void;
  /**
   * JSON array [{name, quality, network}] of the device's installed
   * Vietnamese TTS voices; "[]" until the engine has initialised.
   * (Optional — newer APKs.)
   */
  getNativeVoices?(): string;
  /**
   * Select a device TTS voice by name (from getNativeVoices); "" returns to
   * the engine default. (Optional — newer APKs.)
   */
  setNativeVoice?(name: string): void;
  /**
   * Arm/disarm "sleep when the current chapter ends" — runs in Java so it
   * fires screen-off; mutually exclusive with setSleepTimer.
   * (Optional — newer APKs.)
   */
  setSleepAtChapterEnd?(on: boolean): void;
  /**
   * True when the app is exempt from battery optimizations (Doze). False
   * means aggressive OEMs may kill background playback. (Optional — newer APKs.)
   */
  isIgnoringBatteryOptimizations?(): boolean;
  /** Show the system battery-optimization exemption dialog. (Optional — newer APKs.) */
  requestIgnoreBatteryOptimizations?(): void;
  /**
   * Save a http(s) URL into the system Downloads folder via Android's
   * DownloadManager — the WebView itself silently drops download links.
   * (Optional — newer APKs.)
   */
  downloadFile?(url: string, fileName: string): void;
  updateTitle(title: string): void;
  /** Set the cover image URL shown on the lockscreen / media notification. */
  updateCover(url: string): void;
  getCurrentChunk(): number;
  getCurrentChapterId(): string;
  /** Chapter title native is currently playing (optional — newer APKs). */
  getCurrentTitle?(): string;
  /** Book id of the native session (optional — newer APKs). */
  getCurrentBookId?(): string;
  /** Book title of the native session (optional — newer APKs). */
  getCurrentBookTitle?(): string;
  /** Cover URL of the native session's book (optional — newer APKs). */
  getCoverUrl?(): string;
  /** Chunk count of the chapter native is playing (optional — newer APKs). */
  getTotalChunks?(): number;
  /**
   * JSON array of the text chunks of the chapter native is playing, "[]"
   * when idle. Offline text recovery for a self-fetched chapter on app
   * reopen. (Optional — newer APKs.)
   */
  getCurrentChunksJson?(): string;
  /**
   * Last listening position on this device as JSON
   * {bookId, chapterId, chunkIdx, ts}, or "". Survives stop/swipe-away/
   * process death — unlike the live session. (Optional — newer APKs.)
   */
  getLastListenPosition?(): string;
  isPlaying(): boolean;
  /**
   * Book-level session info: the id keys Java's durable session snapshot and
   * its background server-progress writes; the title shows as the artist line
   * on the lockscreen / Bluetooth displays. (Optional — newer APKs.)
   */
  setSessionInfo?(bookId: string, bookTitle: string): void;
  /** Queue next chapter for seamless background auto-advance. */
  queueNextChapter(
    chunksJson: string,
    chapterId: string,
    title: string,
    rate: number,
    pitch: number,
  ): void;
  /** Queue ALL remaining chapters at once for continuous background playback. */
  queueAllChapters(chaptersJson: string): void;
  /**
   * Like queueAllChapters but uses mergeQueue() internally — skips the
   * currently-playing chapter so there is never an empty-queue race window.
   * Use for every incremental queue update while playback is in progress.
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
  /**
   * Hand Java an ordered playlist of upcoming chapters so it can self-fetch
   * each chapter's text while the WebView is suspended (screen off).
   * Enables unlimited uninterrupted background playback with minimal memory use.
   *
   * @param chaptersMetaJson JSON array of {id, title, rate, pitch} objects
   * @param apiBase          base URL of the API server
   * @param token            Bearer token for authenticated requests
   */
  setPendingChapters(
    chaptersMetaJson: string,
    apiBase: string,
    token: string,
  ): void;
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

/**
 * Keep the screen on without starting the TTS foreground service.
 * Use for the reader, where audio is not playing and a media notification
 * would be misleading.
 */
export async function acquireScreenWake() {
  if (!isNativePlatform()) return;
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake");
    await KeepAwake.keepAwake();
  } catch {
    /* plugin might not be installed */
  }
}

export async function releaseScreenWake() {
  if (!isNativePlatform()) return;
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake");
    await KeepAwake.allowSleep();
  } catch {
    /* plugin might not be installed */
  }
}
