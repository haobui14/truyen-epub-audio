/**
 * Shared IndexedDB instance for offline storage.
 * Both chapter-text cache and progress queue use this database.
 */

const DB_NAME = "truyen-audio-offline";
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openOfflineDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chapter-text")) {
        db.createObjectStore("chapter-text", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("progress-queue")) {
        db.createObjectStore("progress-queue", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}
