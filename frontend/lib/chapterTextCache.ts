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

export async function cacheChapterText(
  chapterId: string,
  textContent: string,
): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      id: chapterId,
      text_content: textContent,
      cached_at: Date.now(),
    });
  } catch {
    // ignore quota errors
  }
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
