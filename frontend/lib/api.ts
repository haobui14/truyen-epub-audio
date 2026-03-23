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
// Returns: true = success, false = auth error (token invalid → should logout),
//          null = network/server error (Railway cold start etc. → do NOT logout)
let refreshPromise: Promise<boolean | null> | null = null;

export async function tryRefreshToken(): Promise<boolean | null> {
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
      // Server explicitly rejected the token — it is invalid, safe to logout.
      if (!res.ok) return false;
      const data = await res.json();
      const user = getUser();
      if (data.access_token && user) {
        await setAuth(
          data.access_token,
          {
            user_id: data.user_id ?? user.user_id,
            email: data.email ?? user.email,
            role: data.role ?? user.role,
          },
          data.refresh_token ?? refreshToken,
        );
        return true;
      }
      return false;
    } catch {
      // Network/timeout error (e.g. Railway cold start, screen-off on Android).
      // Return null so callers know NOT to clear auth — user can retry.
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  _retry = true,
): Promise<T> {
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
      if (refreshed === true) {
        return request<T>(path, init, false); // retry with new token, no further refresh
      }
      // refreshed === false: server confirmed token is invalid → clear auth.
      // refreshed === null: network error (cold start etc.) → keep auth, surface error.
      if (refreshed === false) clearAuth();
    }
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json();
}

export const api = {
  // Books
  listBooks: () => request<Book[]>("/api/books"),
  getBook: (id: string) => request<Book>(`/api/books/${id}`),
  deleteBook: (id: string) =>
    request<{ message: string }>(`/api/books/${id}`, { method: "DELETE" }),
  updateBook: (
    id: string,
    fields: {
      title?: string;
      author?: string;
      description?: string;
      cover?: File | null;
    },
  ) => {
    const form = new FormData();
    if (fields.title !== undefined) form.append("title", fields.title);
    if (fields.author !== undefined) form.append("author", fields.author);
    if (fields.description !== undefined)
      form.append("description", fields.description);
    if (fields.cover) form.append("cover", fields.cover);
    return request<Book>(`/api/books/${id}`, { method: "PATCH", body: form });
  },
  featureBook: (
    id: string,
    is_featured: boolean,
    featured_label?: string | null,
  ) =>
    request<Book>(`/api/books/${id}/feature`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_featured, featured_label: featured_label ?? null }),
    }),

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
  updateChapterText: (chapterId: string, text_content: string) =>
    request<{ id: string; word_count: number }>(
      `/api/chapters/${chapterId}/text`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text_content }),
      },
    ),
  deleteChapter: (chapterId: string) =>
    request<{ deleted: string; total_chapters: number }>(
      `/api/chapters/${chapterId}`,
      {
        method: "DELETE",
      },
    ),
  updateChapter: (
    chapterId: string,
    fields: { title?: string; chapter_index?: number; text_content?: string },
  ) =>
    request<{
      id: string;
      chapter_index: number;
      title: string;
      word_count: number;
    }>(`/api/chapters/${chapterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }),
  bulkDeleteChapters: (chapterIds: string[]) =>
    request<{ deleted: number; book_totals: Record<string, number> }>(
      `/api/chapters/bulk-delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapter_ids: chapterIds }),
      },
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

  uploadEpubWithProgress: (
    file: File,
    voice: string,
    cover: File | null | undefined,
    onProgress: (percent: number) => void,
  ): Promise<{ book_id: string; status: string }> => {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);
      form.append("voice", voice);
      if (cover) form.append("cover", cover);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/api/upload`);

      const token = getToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("Invalid response"));
          }
        } else {
          reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.addEventListener("abort", () =>
        reject(new Error("Upload cancelled")),
      );

      xhr.send(form);
    });
  },

  // Auth
  login: (email: string, password: string) =>
    request<{
      access_token: string;
      refresh_token?: string;
      user_id: string;
      email: string;
      role: string;
    }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  signup: (email: string, password: string) =>
    request<{
      access_token: string;
      refresh_token?: string;
      user_id: string;
      email: string;
      role: string;
    }>("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  getMe: () =>
    request<{ id: string; email: string; role: string }>("/api/auth/me"),

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
    request<
      Array<{
        book: {
          id: string;
          title: string;
          author?: string;
          cover_url?: string;
          total_chapters: number;
        };
        chapter: { id: string; chapter_index: number; title: string };
        progress_value: number;
        total_value?: number;
        updated_at: string;
      }>
    >("/api/progress/my-books"),
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
  createChapter: (
    bookId: string,
    data: { chapter_index: number; title: string; text_content: string },
  ) =>
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
    request<void>(`/api/genres/assign/${bookId}/${genreId}`, {
      method: "POST",
    }),
  removeGenre: (bookId: string, genreId: string) =>
    request<void>(`/api/genres/assign/${bookId}/${genreId}`, {
      method: "DELETE",
    }),

  // AI fix — streams SSE chunks, calls onChunk with each text delta, returns full text
  aiFixChapter: async (
    chapterId: string,
    text: string,
    onChunk: (delta: string, accumulated: string) => void,
    signal?: AbortSignal,
  ): Promise<string> => {
    const { getToken } = await import("./auth");
    const { API_URL } = await import("./constants");
    const token = getToken();
    const res = await fetch(`${API_URL}/api/chapters/${chapterId}/ai-fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `HTTP ${res.status}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const raw = decoder.decode(value, { stream: true });
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") break;
        try {
          const { text: delta } = JSON.parse(payload) as { text: string };
          accumulated += delta;
          onChunk(delta, accumulated);
        } catch { /* ignore malformed chunks */ }
      }
    }
    return accumulated;
  },
};
