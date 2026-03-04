/**
 * Offline progress queue — stores progress updates in IndexedDB when the
 * network is unavailable and flushes them to the backend when back online.
 */

import { api } from "./api";
import { openOfflineDB } from "./offlineDB";

const STORE_NAME = "progress-queue";

export interface QueuedProgress {
  /** Composite key: `${bookId}:${chapterId}:${progressType}` */
  id: string;
  book_id: string;
  chapter_id: string;
  progress_type: "read" | "listen";
  progress_value: number;
  total_value?: number;
  queued_at: number;
}

/** Enqueue a progress update for later sync. Overwrites any existing entry for the same key. */
export async function enqueueProgress(entry: Omit<QueuedProgress, "id" | "queued_at">): Promise<void> {
  try {
    const db = await openOfflineDB();
    const id = `${entry.book_id}:${entry.chapter_id}:${entry.progress_type}`;
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      ...entry,
      id,
      queued_at: Date.now(),
    });
  } catch {
    // IndexedDB unavailable — nothing we can do
  }
}

/** Get the queued progress value for a specific chapter+type (for local reads). */
export async function getQueuedProgress(
  chapterId: string,
  progressType: "read" | "listen",
): Promise<QueuedProgress | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      // We don't know the bookId, so scan all entries
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(null); return; }
        const val = cursor.value as QueuedProgress;
        if (val.chapter_id === chapterId && val.progress_type === progressType) {
          resolve(val);
          return;
        }
        cursor.continue();
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Flush all queued progress entries to the backend. Returns count of successfully synced items. */
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
          progress_type: entry.progress_type,
          progress_value: entry.progress_value,
          total_value: entry.total_value,
        });
        // Remove from queue on success
        const delTx = db.transaction(STORE_NAME, "readwrite");
        delTx.objectStore(STORE_NAME).delete(entry.id);
        synced++;
      } catch {
        // Still offline or API error — leave in queue for next attempt
        break;
      }
    }
    return synced;
  } catch {
    return 0;
  }
}
