export interface Genre {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  description?: string;
  cover_url?: string;
  voice: string;
  status: "pending" | "parsing" | "parsed" | "converting" | "ready" | "error";
  error_message?: string | null;
  total_chapters: number;
  created_at: string;
  genres: Genre[];
  is_featured?: boolean;
  featured_label?: string | null;
  story_status?: "ongoing" | "completed" | "unknown";
  /** When chapters were last ADDED (append/manual) — drives "Mới cập nhật". */
  last_chapter_added_at?: string | null;
}

export interface Chapter {
  id: string;
  book_id: string;
  chapter_index: number;
  title: string;
  word_count: number;
  status: "pending" | "converting" | "ready" | "error";
  /** Not returned by the chapters-list endpoint anymore (payload slimming);
   *  still present on single-chapter responses. */
  error_message?: string;
  created_at?: string;
  /** Bumped by a DB trigger on every row update — used to detect a stale
   *  offline-cached copy of the chapter text (see lib/chapterTextCache.ts). */
  updated_at: string;
}

export interface PaginatedChapters {
  items: Chapter[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface UserProgress {
  id: string;
  user_id: string;
  book_id: string;
  chapter_id: string;
  progress_value: number;
  total_value?: number;
  chapter_index?: number;
  updated_at: string;
}

export interface MyBookProgressEntry {
  book: {
    id: string;
    title: string;
    author?: string;
    cover_url?: string;
    total_chapters: number;
  };
  chapter: {
    id: string;
    chapter_index: number;
    title: string;
  };
  progress_value: number;
  total_value?: number;
  updated_at: string;
}

export interface UserStats {
  user_id: string;
  total_exp: number;
  total_chapters_read: number;
  total_chapters_listened: number;
  total_words_read: number;
  updated_at: string | null;
}


