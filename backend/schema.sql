-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS books (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    author          TEXT,
    cover_url       TEXT,
    voice           TEXT NOT NULL DEFAULT 'vi-VN-HoaiMyNeural',
    status          TEXT NOT NULL DEFAULT 'pending',
    total_chapters  INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_books_created_at ON books(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);

CREATE TABLE IF NOT EXISTS chapters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id         UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index   INTEGER NOT NULL,
    title           TEXT NOT NULL,
    text_content    TEXT,
    word_count      INTEGER DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(book_id, chapter_index)
);

CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_chapters_status ON chapters(book_id, status);

CREATE TABLE IF NOT EXISTS audio_files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id      UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    book_id         UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    storage_path    TEXT NOT NULL,
    public_url      TEXT NOT NULL,
    file_size_bytes BIGINT,
    duration_seconds FLOAT,
    voice           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_audio_files_book_id ON audio_files(book_id);

-- User reading/listening progress
CREATE TABLE IF NOT EXISTS user_progress (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    book_id         UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id      UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    progress_type   TEXT NOT NULL CHECK (progress_type IN ('read', 'listen')),
    progress_value  FLOAT NOT NULL DEFAULT 0,
    total_value     FLOAT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, book_id, chapter_id, progress_type)
);

CREATE INDEX IF NOT EXISTS idx_user_progress_user_book ON user_progress(user_id, book_id);
CREATE INDEX IF NOT EXISTS idx_user_progress_user_chapter ON user_progress(user_id, chapter_id, progress_type);

-- Storage buckets (run in Supabase dashboard > Storage):
-- 1. Create bucket "epub-uploads" (private)
-- 2. Create bucket "audio" (public)
-- 3. Create bucket "covers" (public)
--
-- Add this RLS policy for "audio" and "covers" buckets:
-- Policy name: "Public read"
-- Operation: SELECT
-- Role: anon
-- USING: true
