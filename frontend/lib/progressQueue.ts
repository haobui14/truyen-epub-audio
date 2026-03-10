/**
 * Offline progress queue — stores progress updates in IndexedDB when the
 * network is unavailable and flushes them to the backend when back online.
 */

import { api } from "./api";
import { openOfflineDB } from "./offlineDB";

const STORE_NAME = "progress-queue";
const LOCAL_STORE = "progress-store";
const MY_BOOKS_CACHE_STORE = "my-books-cache";
const MY_BOOKS_CACHE_KEY = "latest";

export interface QueuedProgress {
  /** Composite key: `${bookId}:${chapterId}` */
  id: string;
  book_id: string;
  chapter_id: string;
  progress_value: number;
  total_value?: number;
  queued_at: number;
}

export async function enqueueProgress(entry: Omit<QueuedProgress, "id" | "queued_at">): Promise<void> {
  try {
    const db = await openOfflineDB();
    const id = `${entry.book_id}:${entry.chapter_id}`;
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ ...entry, id, queued_at: Date.now() });
  } catch {}
}

export async function getQueuedProgress(chapterId: string): Promise<QueuedProgress | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(null); return; }
        const val = cursor.value as QueuedProgress;
        if (val.chapter_id === chapterId) { resolve(val); return; }
        cursor.continue();
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ── Persistent local progress store ──────────────────────────────────────────

export interface LocalProgress {
  /** Composite key: `${bookId}:${chapterId}` */
  id: string;
  book_id: string;
  chapter_id: string;
  progress_value: number;
  total_value?: number;
  updated_at: number;
}

export async function saveLocalProgress(entry: Omit<LocalProgress, "id" | "updated_at">): Promise<void> {
  try {
    const db = await openOfflineDB();
    const id = `${entry.book_id}:${entry.chapter_id}`;
    const tx = db.transaction(LOCAL_STORE, "readwrite");
    tx.objectStore(LOCAL_STORE).put({ ...entry, id, updated_at: Date.now() });
  } catch {}
}

export async function getLocalProgress(chapterId: string): Promise<LocalProgress | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(LOCAL_STORE, "readonly");
      const req = tx.objectStore(LOCAL_STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(null); return; }
        const val = cursor.value as LocalProgress;
        if (val.chapter_id === chapterId) { resolve(val); return; }
        cursor.continue();
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ── My-books API response cache ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setCachedMyBooks(data: any[]): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction(MY_BOOKS_CACHE_STORE, "readwrite");
    tx.objectStore(MY_BOOKS_CACHE_STORE).put(data, MY_BOOKS_CACHE_KEY);
  } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCachedMyBooks(): Promise<any[] | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(MY_BOOKS_CACHE_STORE, "readonly");
      const req = tx.objectStore(MY_BOOKS_CACHE_STORE).get(MY_BOOKS_CACHE_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function flushProgressQueue(): Promise<number> {
  try {
    const db = await openOfflineDB();
    const entries = await new Promise<QueuedProgress[]>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });

    if (entries.length === 0) return 0;

    let synced = 0;
    for (const entry of entries) {
      try {
        await api.saveProgress({
          book_id: entry.book_id,
          chapter_id: entry.chapter_id,
          progress_value: entry.progress_value,
          total_value: entry.total_value,
        });
        const delTx = db.transaction(STORE_NAME, "readwrite");
        delTx.objectStore(STORE_NAME).delete(entry.id);
        synced++;
      } catch {
        break;
      }
    }
    return synced;
  } catch {
    return 0;
  }
}
