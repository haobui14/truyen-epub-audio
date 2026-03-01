/**
 * Persistent cache for chapter text content using IndexedDB.
 * Enables offline native TTS by storing chapter text locally.
 */

const DB_NAME = "truyen-audio-offline";
const STORE_NAME = "chapter-text";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedChapterText(
  chapterId: string,
): Promise<string | null> {
  try {
    const db = await openDB();
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
    const db = await openDB();
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
