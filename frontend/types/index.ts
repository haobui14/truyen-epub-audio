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
  /** Successful append/manual addition after initial import; otherwise null. */
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

/** Derived from user_progress by GET /api/stats/me — nothing is stored. */
export interface UserStats {
  user_id: string;
  total_exp: number;
  /** Chapters before the current one in each book; a finished book counts in full. */
  chapters_completed: number;
}


