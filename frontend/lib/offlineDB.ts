/**
 * Shared IndexedDB instance for offline storage.
 * Both chapter-text cache and progress queue use this database.
 */

const DB_NAME = "truyen-audio-offline";
// v3: added "progress-store" (persistent local progress) and "my-books-cache"
const DB_VERSION = 3;

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
      // Guard each store — safe for upgrades from any previous version
      if (!db.objectStoreNames.contains("chapter-text")) {
        db.createObjectStore("chapter-text", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("progress-queue")) {
        db.createObjectStore("progress-queue", { keyPath: "id" });
      }
      // Persistent local progress — never deleted (queue entries are removed after sync)
      if (!db.objectStoreNames.contains("progress-store")) {
        db.createObjectStore("progress-store", { keyPath: "id" });
      }
      // Cache for the last successful /api/progress/my-books response
      if (!db.objectStoreNames.contains("my-books-cache")) {
        db.createObjectStore("my-books-cache");
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
