import { API_URL } from "./constants";
import { getToken, getRefreshToken, clearAuth, setAuth, getUser } from "./auth";
import type {
  Book,
  Chapter,
  Genre,
  PaginatedChapters,
  UserProgress,
  UserStats,
} from "@/types";

// Must match backend settings.max_upload_size_mb (config.py). Frontend uses
// this for pre-flight size checks so users get an instant "too large" error
// instead of streaming 200MB just to get a 413 back.
export const MAX_UPLOAD_MB = 50;
export const ACCEPTED_UPLOAD_EXTS = [".epub", ".pdf", ".txt", ".prc", ".mobi"];

// Result of POST /api/books/{id}/append-chapters (webnovel update flow).
export interface AppendChaptersResult {
  existing_chapters: number;
  parsed_chapters: number;
  appended: number;
  skipped_duplicates: number;
  new_total: number;
  replaced_original: boolean;
}

// Result of POST /api/books/{id}/strip-string. dry_run reports what WOULD be
// removed without writing — always preview first, because a target that
// matches nothing is indistinguishable from a successful run.
export interface StripStringResult {
  dry_run: boolean;
  scanned_chapters: number;
  matched_chapters: number;
  total_occurrences: number;
  updated_chapters: number;
  failed_chapters: number;
  error_sample: string | null;
  samples: string[];
}

// Signup returns no tokens: the account is created in a 'pending' state and an
// admin has to approve it before the first sign-in is possible.
export interface SignupResult {
  status: string;
  message: string;
}

// A row in the admin approval queue.
export interface AdminUser {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  approval_status: "pending" | "approved" | "rejected";
  approval_decided_at: string | null;
}

// Per-request timeout. Generous enough to ride out a Railway cold start but
// short enough that a truly dead request surfaces a retryable error instead of
// an infinite spinner.
const REQUEST_TIMEOUT_MS = 30_000;

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
      if (!res.ok) {
        // 5xx / 408 / 429 are transient (Supabase blip, gateway hiccup, rate
        // limit). Returning null keeps the user signed in so they can retry —
        // only an explicit 4xx rejection should clear the session.
        if (res.status >= 500 || res.status === 408 || res.status === 429) {
          return null;
        }
        return false;
      }
      const data = await res.json();
      // Build the user from the refresh RESPONSE, not from localStorage. After an
      // Android process death the tokens can hydrate from SharedPreferences while
      // auth_user does not — gating on a non-null getUser() would turn a
      // SUCCESSFUL refresh into a logout (return false → caller calls clearAuth).
      // The /refresh response carries user_id/email/role, so trust it and use any
      // existing fields only to fill gaps.
      if (data.access_token && data.user_id) {
        const existing = getUser();
        await setAuth(
          data.access_token,
          {
            user_id: data.user_id,
            email: data.email ?? existing?.email ?? "",
            role: data.role ?? existing?.role,
            display_name: data.display_name ?? existing?.display_name,
            avatar_base64: data.avatar_base64 ?? existing?.avatar_base64,
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
  // Time out a stuck request (e.g. a Railway cold start) so the UI shows a
  // retryable error instead of spinning forever. Skipped when the caller passes
  // its own signal — it owns cancellation then.
  const ctrl = init?.signal ? null : new AbortController();
  const timeoutId = ctrl
    ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    : null;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? ctrl?.signal,
    });
  } catch (err) {
    // A timeout/abort is NOT an auth failure — never clearAuth here.
    if ((err as Error)?.name === "AbortError") {
      throw new Error("Máy chủ phản hồi chậm, vui lòng thử lại.");
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
      story_status?: string;
      cover?: File | null;
    },
  ) => {
    const form = new FormData();
    if (fields.title !== undefined) form.append("title", fields.title);
    if (fields.author !== undefined) form.append("author", fields.author);
    if (fields.description !== undefined)
      form.append("description", fields.description);
    if (fields.story_status !== undefined)
      form.append("story_status", fields.story_status);
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
      body: JSON.stringify({
        is_featured,
        featured_label: featured_label ?? null,
      }),
    }),
  // Latest distributed APK version — the native build compares it against its
  // baked NEXT_PUBLIC_APP_VERSION and shows an update notice when behind.
  getAppVersion: () =>
    request<{
      latest: string;
      version_name: string;
      version_code: number;
      download_url: string | null;
      sha256: string | null;
      minimum_supported_version: string | null;
    }>("/api/app-version"),
  // URL of the generated EPUB export — used directly on Android, where
  // DownloadManager fetches it itself and must be handed the bearer token
  // separately (see TtsBridge.downloadFile).
  bookEpubUrl: (bookId: string) => `${API_URL}/api/books/${bookId}/epub`,
  // Fetch the generated EPUB as a Blob. Deliberately NOT request(): the file
  // is built on demand and can outlive REQUEST_TIMEOUT_MS on big books, and
  // the response is binary, not JSON.
  fetchBookEpub: async (bookId: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`${API_URL}/api/books/${bookId}/epub`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.detail ?? "";
      } catch {
        // non-JSON error body — fall through to the generic message
      }
      throw new Error(
        detail || `Không tạo được file EPUB (HTTP ${res.status})`,
      );
    }
    return res.blob();
  },

  // Chapters
  getBookChapters: (bookId: string, page = 1, pageSize = 100) =>
    request<PaginatedChapters>(
      `/api/books/${bookId}/chapters?page=${page}&page_size=${pageSize}`,
    ),
  getAllBookChapters: async (bookId: string): Promise<PaginatedChapters> => {
    // One request covers any real catalog (backend caps page_size at 10000),
    // avoiding the N-1 parallel page fetches a 1000-cap triggered on big books.
    const PAGE_SIZE = 10000;
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
    request<{ id: string; text_content: string; updated_at: string }>(
      `/api/chapters/${chapterId}/text`,
    ),
  updateChapterText: (chapterId: string, text_content: string) =>
    request<{ id: string; word_count: number; updated_at?: string | null }>(
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
      updated_at?: string | null;
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

  // Upload
  uploadEpubWithProgress: (
    file: File,
    voice: string,
    cover: File | null | undefined,
    onProgress: (percent: number) => void,
  ): {
    promise: Promise<{ book_id: string; status: string }>;
    abort: () => void;
  } => {
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

    const promise = new Promise<{ book_id: string; status: string }>(
      (resolve, reject) => {
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error("Invalid response"));
            }
          } else {
            // Server returns JSON {detail: "..."} on FastAPI errors. Pull out
            // the human message when available so the user sees "File too large"
            // instead of raw JSON.
            let msg = xhr.responseText || `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText);
              if (parsed?.detail) msg = parsed.detail;
            } catch {
              /* not JSON — keep raw */
            }
            reject(new Error(msg));
          }
        });

        xhr.addEventListener("error", () =>
          reject(new Error("Network error — check your connection and retry")),
        );
        xhr.addEventListener("abort", () =>
          reject(new DOMException("Upload cancelled", "AbortError")),
        );
      },
    );

    xhr.send(form);

    return { promise, abort: () => xhr.abort() };
  },

  // Admin: append NEW chapters to an existing book from a re-downloaded file
  // (EPUB/TXT/PDF/MOBI/PRC) — the "webnovel got more chapters" update flow.
  // Existing chapter rows (and therefore reading progress + XP) are untouched.
  // mode "auto": file is a full bundle, backend finds the new tail;
  // mode "all": file contains only the new chapters.
  appendChaptersWithProgress: (
    bookId: string,
    file: File,
    mode: "auto" | "all",
    onProgress: (percent: number) => void,
  ): {
    promise: Promise<AppendChaptersResult>;
    abort: () => void;
  } => {
    const form = new FormData();
    form.append("file", file);
    form.append("mode", mode);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/books/${bookId}/append-chapters`);

    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    const promise = new Promise<AppendChaptersResult>((resolve, reject) => {
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("Invalid response"));
          }
        } else {
          let msg = xhr.responseText || `HTTP ${xhr.status}`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed?.detail) msg = parsed.detail;
          } catch {
            /* not JSON — keep raw */
          }
          reject(new Error(msg));
        }
      });

      xhr.addEventListener("error", () =>
        reject(new Error("Network error — check your connection and retry")),
      );
      xhr.addEventListener("abort", () =>
        reject(new DOMException("Upload cancelled", "AbortError")),
      );
    });

    xhr.send(form);

    return { promise, abort: () => xhr.abort() };
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
    request<SignupResult>("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),

  // Admin: the approval queue.
  listUsers: () => request<AdminUser[]>("/api/auth/users"),
  decideApproval: (
    userId: string,
    status: "approved" | "rejected" | "pending",
  ) =>
    request<{ id: string; approval_status: string }>(
      `/api/auth/users/${userId}/approval`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
    ),
  getMe: () =>
    request<{ id: string; email: string; role: string; display_name: string | null; avatar_base64: string | null }>("/api/auth/me"),
  updateProfile: (fields: { display_name?: string; avatar_base64?: string }) =>
    request<{ display_name: string | null; avatar_base64: string | null }>(
      "/api/auth/update-profile",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      },
    ),

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
  // Admin: join all chapters and re-split by Chương/Chapter headers
  // Admin: re-split a book by chapter headers. Rewrites every chapter through
  // Storage, so on a big book it runs for minutes — REQUEST_TIMEOUT_MS would
  // abort the client while the server carried on deleting and reinserting
  // rows. Own signal with a bulk-sized budget, same as stripStringFromChapters.
  autoSplitBook: (bookId: string) => {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 600_000);
    return request<{
      old_count: number;
      new_count: number;
      missing_chapters: Array<{ title: string; chapter_index: number }>;
      // Set when the split reproduced the structure the book already had, so
      // nothing was rewritten.
      unchanged?: boolean;
    }>(`/api/books/${bookId}/auto-split`, {
      method: "POST",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timeoutId));
  },

  // Admin: re-run the EPUB parser against the original file in epub-uploads.
  // Wipes existing chapters + audio first. Returns immediately; parsing runs
  // in the background — poll book status (parsing → parsed → converting).
  reparseBook: (bookId: string) =>
    request<{ book_id: string; status: string; source: string }>(
      `/api/books/${bookId}/reparse`,
      { method: "POST" },
    ),

  // Admin: remove a literal string (or regex match) from all chapters' text.
  // Rewrites every affected chapter in Storage, so on big books it runs for
  // minutes — REQUEST_TIMEOUT_MS would abort it mid-flight. Own signal
  // (request() then skips its default timeout) with a bulk-sized budget.
  stripStringFromChapters: (
    bookId: string,
    target: string,
    opts: { regex?: boolean; wholeLine?: boolean; dryRun?: boolean } = {},
  ) => {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 600_000);
    return request<StripStringResult>(`/api/books/${bookId}/strip-string`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        regex: opts.regex ?? false,
        whole_line: opts.wholeLine ?? false,
        dry_run: opts.dryRun ?? false,
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timeoutId));
  },

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

  // Admin: split a merged chapter into multiple chapters
  splitChapter: (
    chapterId: string,
    parts: Array<{ title: string; text_content: string }>,
  ) =>
    request<{
      chapter_id: string;
      new_chapter_ids: string[];
      total_chapters: number;
    }>(`/api/chapters/${chapterId}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    }),

  // Stats / XP
  completeChapter: (data: {
    chapter_id: string;
    book_id: string;
    mode: "read" | "listen";
    word_count: number;
  }) =>
    request<{ exp_earned: number; already_completed: boolean; total_exp: number | null }>(
      "/api/stats/complete-chapter",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
    ),
  getMyStats: () => request<UserStats>("/api/stats/me"),

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
        } catch {
          /* ignore malformed chunks */
        }
      }
    }
    return accumulated;
  },
};
