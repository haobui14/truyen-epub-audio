/**
 * Persistent cache for full-chapter TTS audio using the browser Cache API.
 * Keys are scoped to chapterId + voice so voice changes invalidate old entries.
 */

const CACHE_NAME = "chapter-audio-v2";

function cacheKey(chapterId: string, voice: string): string {
  return `chapter-audio://${chapterId}/${voice}`;
}

export async function isChapterCached(
  chapterId: string,
  voice: string
): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return !!(await cache.match(cacheKey(chapterId, voice)));
  } catch {
    return false;
  }
}

/**
 * Returns a temporary blob URL for the cached audio, or null if not cached.
 * Caller is responsible for calling URL.revokeObjectURL when done.
 */
export async function getCachedAudioUrl(
  chapterId: string,
  voice: string
): Promise<string | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(cacheKey(chapterId, voice));
    if (!response) return null;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Store a chapter audio blob in the Cache API.
 * Silently ignores quota errors.
 */
export async function cacheChapterAudio(
  chapterId: string,
  voice: string,
  blob: Blob
): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      cacheKey(chapterId, voice),
      new Response(blob, { headers: { "Content-Type": "audio/mpeg" } })
    );
  } catch {
    // Quota exceeded or incognito mode — ignore
  }
}

export async function evictChapterAudio(
  chapterId: string,
  voice: string
): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(cacheKey(chapterId, voice));
  } catch {
    // ignore
  }
}
