/**
 * IndexedDB cache for books list, book details, and chapter pages.
 * Enables offline browsing: home screen and book detail page work without network.
 */

import { openOfflineDB } from "./offlineDB";
import type { Book, PaginatedChapters } from "@/types";

// ── Books list ────────────────────────────────────────────────────────────────

export async function getCachedBooks(): Promise<Book[] | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const req = db.transaction("books-list", "readonly")
        .objectStore("books-list")
        .get("all");
      req.onsuccess = () => resolve((req.result as Book[]) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheBooks(books: Book[]): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction("books-list", "readwrite");
    tx.objectStore("books-list").put(books, "all");
  } catch {
    // ignore quota errors
  }
}

// ── Single book ───────────────────────────────────────────────────────────────

export async function getCachedBook(bookId: string): Promise<Book | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const req = db.transaction("book-detail", "readonly")
        .objectStore("book-detail")
        .get(bookId);
      req.onsuccess = () => resolve((req.result as Book) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheBook(book: Book): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction("book-detail", "readwrite");
    tx.objectStore("book-detail").put(book);
  } catch {
    // ignore quota errors
  }
}

// ── Chapter pages ─────────────────────────────────────────────────────────────

export async function getCachedChapters(
  bookId: string,
  page: number,
): Promise<PaginatedChapters | null> {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve) => {
      const req = db.transaction("book-chapters", "readonly")
        .objectStore("book-chapters")
        .get(`${bookId}:${page}`);
      req.onsuccess = () => resolve((req.result as PaginatedChapters) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheChapters(
  bookId: string,
  page: number,
  data: PaginatedChapters,
): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction("book-chapters", "readwrite");
    tx.objectStore("book-chapters").put(data, `${bookId}:${page}`);
  } catch {
    // ignore quota errors
  }
}
