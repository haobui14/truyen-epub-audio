/**
 * Offline progress queue — stores progress updates in IndexedDB when the
 * network is unavailable and flushes them to the backend when back online.
 */

import { api } from "./api";
import { isLoggedIn } from "./auth";
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

// ── Book-level progress (tracks the latest chapter per book locally) ─────────

export interface LocalBookProgress {
  /** Key: `book:${bookId}` */
  id: string;
  book_id: string;
  chapter_id: string;
  chapter_index: number;
  progress_value: number;
  total_value?: number;
  updated_at: number;
}

/**
 * Save book-level progress. Only overwrites if the new chapter_index >= existing.
 * This ensures local progress never goes backward.
 */
export async function saveLocalBookProgress(
  entry: Omit<LocalBookProgress, "id" | "updated_at">,
): Promise<void> {
  try {
    const db = await openOfflineDB();
    const id = `book:${entry.book_id}`;

    // Read existing to avoid overwriting with an older chapter
    const existing = await new Promise<LocalBookProgress | undefined>((res) => {
      const tx = db.transaction(LOCAL_STORE, "readonly");
      const req = tx.objectStore(LOCAL_STORE).get(id);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(undefined);
    });

    if (existing && existing.chapter_index > entry.chapter_index) {
      return; // Local already has a more recent chapter
    }

    const tx2 = db.transaction(LOCAL_STORE, "readwrite");
    tx2.objectStore(LOCAL_STORE).put({ ...entry, id, updated_at: Date.now() });
  } catch {}
}

export async function getLocalBookProgress(
  bookId: string,
): Promise<LocalBookProgress | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(LOCAL_STORE, "readonly");
      const req = tx.objectStore(LOCAL_STORE).get(`book:${bookId}`);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Sync local book progress to the server for a given book.
 * Pushes local progress only if its chapter_index > the server's.
 */
export async function syncBookProgressToServer(bookId: string): Promise<boolean> {
  if (!isLoggedIn()) return false;
  try {
    const local = await getLocalBookProgress(bookId);
    if (!local) return false;

    const server = await api.getBookProgress(bookId);

    // No server progress, or server is behind → push local
    if (!server || (server.chapter_index != null && local.chapter_index > server.chapter_index)) {
      await api.saveProgress({
        book_id: local.book_id,
        chapter_id: local.chapter_id,
        progress_value: local.progress_value,
        total_value: local.total_value,
      });
      return true;
    }

    // Server chapter_index unknown (old API) but different chapter → push local
    if (server.chapter_index == null && server.chapter_id !== local.chapter_id) {
      await api.saveProgress({
        book_id: local.book_id,
        chapter_id: local.chapter_id,
        progress_value: local.progress_value,
        total_value: local.total_value,
      });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a chapter is still the latest for its book in local progress.
 * Used to avoid stale flushes overwriting newer progress.
 */
export async function isLatestChapterForBook(
  bookId: string,
  chapterIndex: number,
): Promise<boolean> {
  try {
    const local = await getLocalBookProgress(bookId);
    if (!local) return true; // No book progress → this is the latest
    return chapterIndex >= local.chapter_index;
  } catch {
    return true;
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

    // Group entries by book_id and only sync the LATEST entry per book
    // (based on queued_at). This avoids stale queue entries from overwriting
    // newer progress on the server.
    const latestPerBook = new Map<string, QueuedProgress>();
    for (const entry of entries) {
      const existing = latestPerBook.get(entry.book_id);
      if (!existing || entry.queued_at > existing.queued_at) {
        latestPerBook.set(entry.book_id, entry);
      }
    }

    // Also check if local book progress is ahead of each queue entry
    for (const [bookId, queueEntry] of latestPerBook) {
      const local = await getLocalBookProgress(bookId);
      if (local && local.chapter_id !== queueEntry.chapter_id) {
        // Local book progress points to a different (likely newer) chapter.
        // Replace the queue entry with local book progress data.
        latestPerBook.set(bookId, {
          ...queueEntry,
          chapter_id: local.chapter_id,
          progress_value: local.progress_value,
          total_value: local.total_value,
          queued_at: local.updated_at,
        });
      }
    }

    let synced = 0;
    for (const entry of latestPerBook.values()) {
      try {
        await api.saveProgress({
          book_id: entry.book_id,
          chapter_id: entry.chapter_id,
          progress_value: entry.progress_value,
          total_value: entry.total_value,
        });
        // Delete all queued entries for this book
        for (const qe of entries.filter((e) => e.book_id === entry.book_id)) {
          const delTx = db.transaction(STORE_NAME, "readwrite");
          delTx.objectStore(STORE_NAME).delete(qe.id);
        }
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
