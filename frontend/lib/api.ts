import { API_URL } from "./constants";
import { getToken, getRefreshToken, clearAuth, setAuth, getUser } from "./auth";
import type {
  Book,
  Chapter,
  Genre,
  TtsStatus,
  AudioSummary,
  PaginatedChapters,
  UserProgress,
} from "@/types";

// Prevent multiple concurrent refresh attempts
let refreshPromise: Promise<boolean> | null = null;

export async function tryRefreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      const user = getUser();
      if (data.access_token && user) {
        await setAuth(data.access_token, {
          user_id: data.user_id ?? user.user_id,
          email: data.email ?? user.email,
          role: data.role ?? user.role,
        }, data.refresh_token ?? refreshToken);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function request<T>(path: string, init?: RequestInit, _retry = true): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    if (res.status === 401 && token && _retry) {
      // Token expired — try to refresh once, then retry the original request.
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        return request<T>(path, init, false); // retry with new token, no further refresh
      }
      // Refresh also failed — clear auth and surface the error
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
  getAllBookChapters: async (bookId: string): Promise<PaginatedChapters> => {
    const PAGE_SIZE = 1000;
    const first = await request<PaginatedChapters>(
      `/api/books/${bookId}/chapters?page=1&page_size=${PAGE_SIZE}`,
    );
    if (first.total_pages <= 1) return first;
    const rest = await Promise.all(
      Array.from({ length: first.total_pages - 1 }, (_, i) =>
        request<PaginatedChapters>(
          `/api/books/${bookId}/chapters?page=${i + 2}&page_size=${PAGE_SIZE}`,
        ),
      ),
    );
    return {
      ...first,
      items: [first, ...rest].flatMap((p) => p.items),
    };
  },
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
    request<{ access_token: string; refresh_token?: string; user_id: string; email: string; role: string }>(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
    ),
  signup: (email: string, password: string) =>
    request<{ access_token: string; refresh_token?: string; user_id: string; email: string; role: string }>(
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
    progress_value: number;
    total_value?: number;
  }) =>
    request<UserProgress>("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  getMyBooks: () =>
    request<Array<{
      book: { id: string; title: string; author?: string; cover_url?: string; total_chapters: number };
      chapter: { id: string; chapter_index: number; title: string };
      progress_value: number;
      total_value?: number;
      updated_at: string;
    }>>("/api/progress/my-books"),
  getChapterProgress: (chapterId: string) =>
    request<UserProgress | null>(`/api/progress/chapter/${chapterId}`),
  getBookProgress: (bookId: string) =>
    request<UserProgress | null>(`/api/progress/book/${bookId}`),

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
