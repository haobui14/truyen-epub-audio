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
  total_chapters: number;
  created_at: string;
  genres: Genre[];
  is_featured?: boolean;
  featured_label?: string | null;
  story_status?: "ongoing" | "completed" | "unknown";
}

export interface Chapter {
  id: string;
  book_id: string;
  chapter_index: number;
  title: string;
  word_count: number;
  status: "pending" | "converting" | "ready" | "error";
  error_message?: string;
  created_at: string;
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

export interface UserStats {
  user_id: string;
  total_exp: number;
  total_chapters_read: number;
  total_chapters_listened: number;
  total_words_read: number;
  updated_at: string | null;
}


