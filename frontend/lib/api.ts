import { API_URL } from "./constants";
import type { Book, Chapter, TtsStatus, AudioSummary, PaginatedChapters } from "@/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Books
  listBooks: () => request<Book[]>("/api/books"),
  getBook: (id: string) => request<Book>(`/api/books/${id}`),
  deleteBook: (id: string) =>
    request<{ message: string }>(`/api/books/${id}`, { method: "DELETE" }),

  // Chapters
  getBookChapters: (bookId: string, page = 1, pageSize = 100) =>
    request<PaginatedChapters>(
      `/api/books/${bookId}/chapters?page=${page}&page_size=${pageSize}`
    ),
  getChapter: (chapterId: string) =>
    request<Chapter>(`/api/chapters/${chapterId}`),
  getChapterText: (chapterId: string) =>
    request<{ id: string; text_content: string }>(`/api/chapters/${chapterId}/text`),

  // TTS
  getTtsStatus: (bookId: string) =>
    request<TtsStatus>(`/api/tts/status/${bookId}`),
  enqueueTtsBook: (bookId: string) =>
    request<{ enqueued: number }>(`/api/tts/book/${bookId}`, {
      method: "POST",
    }),
  retryChapter: (chapterId: string) =>
    request<{ status: string }>(`/api/tts/chapter/${chapterId}`, {
      method: "POST",
    }),
  prefetchChapters: (bookId: string, fromIndex: number, count = 3) =>
    request<{ enqueued: number }>(
      `/api/tts/prefetch/${bookId}?from_index=${fromIndex}&count=${count}`,
      { method: "POST" }
    ),

  // Audio
  getAudio: (chapterId: string) =>
    request<{
      id: string;
      chapter_id: string;
      public_url: string;
      duration_seconds?: number;
    }>(`/api/audio/${chapterId}`),

  // Upload
  uploadEpub: (file: File, voice: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("voice", voice);
    return request<{ book_id: string; status: string }>("/api/upload", {
      method: "POST",
      body: form,
    });
  },
};
