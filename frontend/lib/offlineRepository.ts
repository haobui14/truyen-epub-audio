import { isNativePlatform } from "./capacitor";
import { openOfflineDB } from "./offlineDB";

export type OfflineBookStatus =
  | "downloading"
  | "ready"
  | "partial"
  | "stale"
  | "error";

export interface OfflineBookState {
  book_id: string;
  book_title: string;
  status: OfflineBookStatus;
  total_chapters: number;
  completed_chapters: number;
  failed_chapters: number;
  stale_chapters: number;
  bytes_total: number;
  chapter_ids: string[];
  failed_chapter_ids: string[];
  version: string | null;
  last_successful_sync: number | null;
  updated_at: number;
  error_code?:
    | "storage-full"
    | "network"
    | "unauthorized"
    | "cancelled"
    | "unknown";
  error_message?: string;
}

export interface OfflineChapterRecord {
  id: string;
  book_id: string;
  text_content: string;
  cached_at: number;
  server_updated_at?: string;
  bytes: number;
}

export interface OfflineRepository {
  readonly platform: "web" | "native";
  getBookState(bookId: string): Promise<OfflineBookState | null>;
  listBookStates(): Promise<OfflineBookState[]>;
  getChapter(
    bookId: string,
    chapterId: string,
  ): Promise<OfflineChapterRecord | null>;
  listChapterIds(bookId: string): Promise<string[]>;
  saveBookState(state: OfflineBookState): Promise<void>;
  saveChapter(record: OfflineChapterRecord): Promise<void>;
  removeBook(bookId: string): Promise<void>;
  enqueueBookDownload?(input: {
    bookId: string;
    bookTitle: string;
    chapters: Array<{ id: string; updated_at?: string }>;
    apiBase: string;
  }): Promise<void>;
  cancelBookDownload?(bookId: string): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbOfflineRepository implements OfflineRepository {
  readonly platform = "web" as const;

  async getBookState(bookId: string) {
    const db = await openOfflineDB();
    const request = db
      .transaction("offline-book-state", "readonly")
      .objectStore("offline-book-state")
      .get(bookId);
    return (await requestResult(request)) ?? null;
  }

  async listBookStates() {
    const db = await openOfflineDB();
    const request = db
      .transaction("offline-book-state", "readonly")
      .objectStore("offline-book-state")
      .getAll();
    return requestResult(request);
  }

  async getChapter(_bookId: string, chapterId: string) {
    const db = await openOfflineDB();
    const request = db
      .transaction("chapter-text", "readonly")
      .objectStore("chapter-text")
      .get(chapterId);
    return (await requestResult(request)) ?? null;
  }

  async listChapterIds(bookId: string) {
    const db = await openOfflineDB();
    const request = db
      .transaction("chapter-text", "readonly")
      .objectStore("chapter-text")
      .getAll();
    const chapters = await requestResult(request);
    return chapters
      .filter((chapter) => !chapter.book_id || chapter.book_id === bookId)
      .map((chapter) => chapter.id);
  }

  async saveBookState(state: OfflineBookState) {
    const db = await openOfflineDB();
    const transaction = db.transaction("offline-book-state", "readwrite");
    transaction.objectStore("offline-book-state").put(state);
    await transactionDone(transaction);
  }

  async saveChapter(record: OfflineChapterRecord) {
    const db = await openOfflineDB();
    const transaction = db.transaction("chapter-text", "readwrite");
    transaction.objectStore("chapter-text").put(record);
    await transactionDone(transaction);
  }

  async removeBook(bookId: string) {
    const state = await this.getBookState(bookId);
    const db = await openOfflineDB();
    const chapterPageKeys = await requestResult(
      db
        .transaction("book-chapters", "readonly")
        .objectStore("book-chapters")
        .getAllKeys(),
    );
    const storeNames = [
      "offline-book-state",
      "chapter-text",
      "book-detail",
      "book-chapters",
      "book-covers",
    ];
    const transaction = db.transaction(storeNames, "readwrite");
    const chapters = transaction.objectStore("chapter-text");
    for (const chapterId of state?.chapter_ids ?? []) chapters.delete(chapterId);
    transaction.objectStore("offline-book-state").delete(bookId);
    transaction.objectStore("book-detail").delete(bookId);
    transaction.objectStore("book-covers").delete(bookId);
    const chapterPages = transaction.objectStore("book-chapters");
    for (const key of chapterPageKeys) {
      if (String(key).startsWith(`${bookId}:`)) chapterPages.delete(key);
    }
    await transactionDone(transaction);
  }
}

interface NativeOfflineBridge {
  getBookState(bookId: string): string;
  listBookStates(): string;
  getChapter(bookId: string, chapterId: string): string;
  listChapterIds(bookId: string): string;
  saveBookState(json: string): boolean;
  saveChapter(json: string): boolean;
  enqueueDownload(
    bookId: string,
    bookTitle: string,
    chaptersJson: string,
    apiBase: string,
  ): boolean;
  cancelDownload(bookId: string): boolean;
  removeBook(bookId: string): boolean;
}

function nativeBridge(): NativeOfflineBridge | undefined {
  return (window as Window & { OfflineBridge?: NativeOfflineBridge }).OfflineBridge;
}

export class NativeOfflineRepository implements OfflineRepository {
  readonly platform = "native" as const;

  private requireBridge() {
    const bridge = nativeBridge();
    if (!bridge) throw new Error("native-offline-bridge-unavailable");
    return bridge;
  }

  async getBookState(bookId: string) {
    const raw = this.requireBridge().getBookState(bookId);
    return raw ? (JSON.parse(raw) as OfflineBookState) : null;
  }

  async listBookStates() {
    const raw = this.requireBridge().listBookStates();
    return raw ? (JSON.parse(raw) as OfflineBookState[]) : [];
  }

  async getChapter(bookId: string, chapterId: string) {
    const raw = this.requireBridge().getChapter(bookId, chapterId);
    return raw ? (JSON.parse(raw) as OfflineChapterRecord) : null;
  }

  async listChapterIds(bookId: string) {
    const raw = this.requireBridge().listChapterIds(bookId);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  async saveBookState(state: OfflineBookState) {
    if (!this.requireBridge().saveBookState(JSON.stringify(state))) {
      throw new Error("native-offline-state-write-failed");
    }
  }

  async saveChapter(record: OfflineChapterRecord) {
    if (!this.requireBridge().saveChapter(JSON.stringify(record))) {
      throw new Error("native-offline-chapter-write-failed");
    }
  }

  async enqueueBookDownload(input: {
    bookId: string;
    bookTitle: string;
    chapters: Array<{ id: string; updated_at?: string }>;
    apiBase: string;
  }) {
    if (
      !this.requireBridge().enqueueDownload(
        input.bookId,
        input.bookTitle,
        JSON.stringify(input.chapters),
        input.apiBase,
      )
    ) {
      throw new Error("native-offline-enqueue-failed");
    }
  }

  async cancelBookDownload(bookId: string) {
    if (!this.requireBridge().cancelDownload(bookId)) {
      throw new Error("native-offline-cancel-failed");
    }
  }

  async removeBook(bookId: string) {
    if (!this.requireBridge().removeBook(bookId)) {
      throw new Error("native-offline-remove-failed");
    }
  }
}

let repository: OfflineRepository | null = null;

export function getOfflineRepository(): OfflineRepository {
  if (!repository) {
    repository =
      isNativePlatform() && typeof window !== "undefined" && nativeBridge()
        ? new NativeOfflineRepository()
        : new IndexedDbOfflineRepository();
  }
  return repository;
}

export function classifyOfflineError(error: unknown): Pick<
  OfflineBookState,
  "error_code" | "error_message"
> {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|space|disk|storage/i.test(message)) {
    return {
      error_code: "storage-full",
      error_message: "Không đủ dung lượng. Hãy xóa bớt truyện đã tải rồi thử lại.",
    };
  }
  if (/401|403|unauthorized/i.test(message)) {
    return {
      error_code: "unauthorized",
      error_message: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.",
    };
  }
  if (/network|offline|fetch/i.test(message)) {
    return {
      error_code: "network",
      error_message: "Mất kết nối. Tiến trình đã lưu và có thể tiếp tục sau.",
    };
  }
  return {
    error_code: "unknown",
    error_message: "Không thể hoàn tất tải xuống. Hãy thử lại.",
  };
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function getOfflineChapter(bookId: string, chapterId: string) {
  return getOfflineRepository().getChapter(bookId, chapterId);
}

export function getOfflineChapterIds(bookId: string) {
  return getOfflineRepository().listChapterIds(bookId);
}

export function saveOfflineChapterText(
  bookId: string,
  chapterId: string,
  textContent: string,
  serverUpdatedAt?: string,
) {
  return getOfflineRepository().saveChapter({
    id: chapterId,
    book_id: bookId,
    text_content: textContent,
    cached_at: Date.now(),
    server_updated_at: serverUpdatedAt,
    bytes: utf8Bytes(textContent),
  });
}
