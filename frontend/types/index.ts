export interface Book {
  id: string;
  title: string;
  author?: string;
  cover_url?: string;
  voice: string;
  status: "pending" | "parsing" | "parsed" | "converting" | "ready" | "error";
  total_chapters: number;
  created_at: string;
}

export interface AudioSummary {
  public_url: string;
  duration_seconds?: number;
  file_size_bytes?: number;
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
  audio?: AudioSummary;
}

export interface PaginatedChapters {
  items: Chapter[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface TtsStatus {
  book_id: string;
  total_chapters: number;
  ready: number;
  failed: number;
  converting: number;
  pending: number;
  chapters: Array<{
    id: string;
    chapter_index: number;
    title: string;
    status: string;
    error_message?: string;
  }>;
}

export const VOICES = [
  { value: "vi-VN-HoaiMyNeural", label: "HoaiMy (Nữ)" },
  { value: "vi-VN-NamMinhNeural", label: "NamMinh (Nam)" },
] as const;

export const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const;
