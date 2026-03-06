import { API_URL } from "./constants";
import { getToken, clearAuth } from "./auth";
import type {
  Book,
  Chapter,
  Genre,
  TtsStatus,
  AudioSummary,
  PaginatedChapters,
  UserProgress,
} from "@/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    // Expired / invalid token — clear stored credentials so the app
    // treats the user as logged out immediately and stops retrying.
    // Only clear when a token was actually sent; a 401 with no token just
    // means the endpoint requires auth (e.g. during native hydration race).
    if (res.status === 401 && token) {
      clearAuth();
    }
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
  updateBook: (id: string, fields: { title?: string; author?: string; cover?: File | null }) => {
    const form = new FormData();
    if (fields.title !== undefined) form.append("title", fields.title);
    if (fields.author !== undefined) form.append("author", fields.author);
    if (fields.cover) form.append("cover", fields.cover);
    return request<Book>(`/api/books/${id}`, { method: "PATCH", body: form });
  },

  // Chapters
  getBookChapters: (bookId: string, page = 1, pageSize = 100) =>
    request<PaginatedChapters>(
      `/api/books/${bookId}/chapters?page=${page}&page_size=${pageSize}`,
    ),
  getChapter: (chapterId: string) =>
    request<Chapter>(`/api/chapters/${chapterId}`),
  getChapterText: (chapterId: string) =>
    request<{ id: string; text_content: string }>(
      `/api/chapters/${chapterId}/text`,
    ),

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
      { method: "POST" },
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
  uploadEpub: (file: File, voice: string, cover?: File | null) => {
    const form = new FormData();
    form.append("file", file);
    form.append("voice", voice);
    if (cover) form.append("cover", cover);
    return request<{ book_id: string; status: string }>("/api/upload", {
      method: "POST",
      body: form,
    });
  },

  // Auth
  login: (email: string, password: string) =>
    request<{ access_token: string; user_id: string; email: string; role: string }>(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
    ),
  signup: (email: string, password: string) =>
    request<{ access_token: string; user_id: string; email: string; role: string }>(
      "/api/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
    ),
  getMe: () => request<{ id: string; email: string; role: string }>("/api/auth/me"),

  // Progress
  saveProgress: (data: {
    book_id: string;
    chapter_id: string;
    progress_type: "read" | "listen";
    progress_value: number;
    total_value?: number;
  }) =>
    request<UserProgress>("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  getChapterProgress: (chapterId: string, type: "read" | "listen") =>
    request<UserProgress | null>(
      `/api/progress/chapter/${chapterId}?progress_type=${type}`,
    ),
  getBookProgress: (bookId: string, type?: string) =>
    request<UserProgress[]>(
      `/api/progress/book/${bookId}${type ? `?progress_type=${type}` : ""}`,
    ),

  // Settings
  getSettings: () =>
    request<{
      user_id: string;
      playback_rate: number;
      playback_pitch: number;
      updated_at: string;
    }>("/api/settings"),
  saveSettings: (data: { playback_rate: number; playback_pitch: number }) =>
    request<{
      user_id: string;
      playback_rate: number;
      playback_pitch: number;
      updated_at: string;
    }>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  // Admin: manual chapter creation
  createChapter: (bookId: string, data: { chapter_index: number; title: string; text_content: string }) =>
    request<Chapter>(`/api/books/${bookId}/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  // Genres
  listGenres: () => request<Genre[]>("/api/genres"),
  createGenre: (name: string, color: string) =>
    request<Genre>("/api/genres", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    }),
  updateGenre: (genreId: string, data: { name?: string; color?: string }) =>
    request<Genre>(`/api/genres/${genreId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deleteGenre: (genreId: string) =>
    request<void>(`/api/genres/${genreId}`, { method: "DELETE" }),
  assignGenre: (bookId: string, genreId: string) =>
    request<void>(`/api/genres/assign/${bookId}/${genreId}`, { method: "POST" }),
  removeGenre: (bookId: string, genreId: string) =>
    request<void>(`/api/genres/assign/${bookId}/${genreId}`, { method: "DELETE" }),
};
