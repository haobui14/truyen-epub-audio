/**
 * Persistent cache for chapter text content using IndexedDB.
 * Enables offline native TTS by storing chapter text locally.
 */

import { openOfflineDB } from "./offlineDB";

const STORE_NAME = "chapter-text";

export async function getCachedChapterText(
  chapterId: string,
): Promise<string | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(chapterId);
      req.onsuccess = () => resolve(req.result?.text_content ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export interface CachedChapterEntry {
  text_content: string;
  cached_at: number;
  /** The server chapter row's `updated_at` at the time this text was cached
   *  (undefined for entries cached before this field existed). Compare
   *  against the chapter's CURRENT `updated_at` (from the chapters list,
   *  fetched fresh whenever online) to detect an admin edit that made this
   *  cached copy stale — see the freshness checks in ListenPageClient /
   *  ReadPageClient / BookDetailClient. */
  server_updated_at?: string;
}

/** Like getCachedChapterText but also returns cache metadata for freshness/TTL checks. */
export async function getCachedChapterEntry(
  chapterId: string,
): Promise<CachedChapterEntry | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(chapterId);
      req.onsuccess = () => {
        const row = req.result;
        if (!row?.text_content) {
          resolve(null);
          return;
        }
        resolve({
          text_content: row.text_content,
          cached_at: row.cached_at ?? 0,
          server_updated_at: row.server_updated_at,
        });
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheChapterText(
  chapterId: string,
  textContent: string,
  serverUpdatedAt?: string,
): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      id: chapterId,
      text_content: textContent,
      cached_at: Date.now(),
      server_updated_at: serverUpdatedAt,
    });
  } catch {
    // ignore quota errors
  }
}

/**
 * Whether a cached chapter-text entry can be served WITHOUT hitting the
 * network: true when offline (no choice — never block on a request the
 * device can't make), or when the entry's recorded server version matches
 * the chapter's CURRENT version. False means the caller should attempt a
 * network refetch (an admin edit may have changed the text, or we simply
 * don't know the current version yet) — but should still fall back to this
 * same cached entry if that attempt fails.
 */
export function canUseCachedChapterText(
  entry: CachedChapterEntry,
  currentServerUpdatedAt: string | undefined,
): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  return (
    !!currentServerUpdatedAt &&
    entry.server_updated_at === currentServerUpdatedAt
  );
}

export async function isChapterTextCached(
  chapterId: string,
): Promise<boolean> {
  const text = await getCachedChapterText(chapterId);
  return text !== null;
}

/** Return all chapter IDs that have text cached in IndexedDB. */
export async function getAllCachedChapterIds(): Promise<string[]> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/** Delete a single chapter's cached text (e.g. to free space). */
export async function evictChapterText(chapterId: string): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(chapterId);
  } catch {
    // ignore
  }
}
