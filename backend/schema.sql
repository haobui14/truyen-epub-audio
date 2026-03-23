-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS books (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    author          TEXT,
    description     TEXT,
    cover_url       TEXT,
    voice           TEXT NOT NULL DEFAULT 'vi-VN-HoaiMyNeural',
    status          TEXT NOT NULL DEFAULT 'pending',
    total_chapters  INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: add description column if upgrading from an older schema
ALTER TABLE books ADD COLUMN IF NOT EXISTS description TEXT;

-- Migration: spotlight / weekly-star columns
ALTER TABLE books ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE books ADD COLUMN IF NOT EXISTS featured_label TEXT;  -- e.g. 'Weekly Star', 'Hot', 'Mới'
-- Only one book should be featured at a time; enforce via app logic.
CREATE INDEX IF NOT EXISTS idx_books_featured ON books(is_featured) WHERE is_featured = TRUE;

-- Migration: story completion status (narrative state, separate from TTS processing status)
ALTER TABLE books ADD COLUMN IF NOT EXISTS story_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (story_status IN ('ongoing', 'completed', 'unknown'));
CREATE INDEX IF NOT EXISTS idx_books_story_status ON books(story_status);

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

-- User reading/listening progress (one row per user+book)
CREATE TABLE IF NOT EXISTS user_progress (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    book_id         UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id      UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    progress_value  FLOAT NOT NULL DEFAULT 0,
    total_value     FLOAT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_user_progress_user_book ON user_progress(user_id, book_id);
CREATE INDEX IF NOT EXISTS idx_user_progress_user_chapter ON user_progress(user_id, chapter_id);

-- User playback settings (speed, pitch — synced across devices)
CREATE TABLE IF NOT EXISTS user_settings (
    user_id         UUID PRIMARY KEY,
    playback_rate   FLOAT NOT NULL DEFAULT 1,
    playback_pitch  FLOAT NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom users table (replaces Supabase Auth)
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens — 90-day expiry, rotated on every use
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token      TEXT PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- User roles (admin-only access control)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id    UUID PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- To grant admin: INSERT INTO user_roles (user_id, role) VALUES ('<uuid>', 'admin')
-- ON CONFLICT (user_id) DO UPDATE SET role = 'admin';

-- Genres (admin-managed global tags for books)
CREATE TABLE IF NOT EXISTS genres (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL DEFAULT 'indigo',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Book ↔ Genre many-to-many
CREATE TABLE IF NOT EXISTS book_genres (
    book_id     UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    genre_id    UUID NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, genre_id)
);

CREATE INDEX IF NOT EXISTS idx_book_genres_genre_id ON book_genres(genre_id);

-- ============================================================
-- Storage RLS policies
-- Run this in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- Drop old policies first to avoid conflicts on re-run
DROP POLICY IF EXISTS "Service role full access on epub-uploads" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access on audio" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access on covers" ON storage.objects;
DROP POLICY IF EXISTS "Public read on audio" ON storage.objects;
DROP POLICY IF EXISTS "Public read on covers" ON storage.objects;

-- Service role: full access on all buckets (needed for backend uploads)
CREATE POLICY "Service role full access on epub-uploads"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'epub-uploads')
WITH CHECK (bucket_id = 'epub-uploads');

CREATE POLICY "Service role full access on audio"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'audio')
WITH CHECK (bucket_id = 'audio');

CREATE POLICY "Service role full access on covers"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'covers')
WITH CHECK (bucket_id = 'covers');

-- Public: read-only on audio and covers
CREATE POLICY "Public read on audio"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = 'audio');

CREATE POLICY "Public read on covers"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = 'covers');

-- Storage buckets (create once in Supabase dashboard > Storage):
-- 1. "epub-uploads" → private
-- 2. "audio"        → public
-- 3. "covers"       → public

-- ============================================================
-- Helper function: bulk re-index chapters after a deletion
-- Run this in Supabase SQL Editor
-- ============================================================
-- Shift all chapters with chapter_index >= p_insert_index up by 1
-- to make room for a new chapter being inserted at that position.
CREATE OR REPLACE FUNCTION shift_chapters_up(
    p_book_id UUID,
    p_insert_index INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Pass 1: shift affected indices to a large range to avoid unique conflicts
    -- when incrementing (e.g. 2→3 would collide with existing 3).
    UPDATE chapters
    SET chapter_index = chapter_index + 1000000
    WHERE book_id = p_book_id
      AND chapter_index >= p_insert_index;

    -- Pass 2: bring them back to their final values (+1 from original).
    UPDATE chapters
    SET chapter_index = chapter_index - 1000000 + 1
    WHERE book_id = p_book_id
      AND chapter_index >= 1000000;
END;
$$;

CREATE OR REPLACE FUNCTION reindex_chapters_after_delete(
    p_book_id UUID,
    p_deleted_index INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Pass 1: shift affected indices to negative to avoid unique constraint
    -- conflicts when decrementing (e.g. 4→3 would collide with existing 3).
    UPDATE chapters
    SET chapter_index = -(chapter_index - 1)
    WHERE book_id = p_book_id
      AND chapter_index > p_deleted_index;

    -- Pass 2: flip negatives to their final positive values.
    UPDATE chapters
    SET chapter_index = -chapter_index
    WHERE book_id = p_book_id
      AND chapter_index < 0;
END;
$$;

CREATE OR REPLACE FUNCTION reindex_all_chapters(p_book_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Pass 1: shift all indices to a large range so pass 2 assignments
    -- (0, 1, 2, ...) never collide with the shifted values.
    UPDATE chapters
    SET chapter_index = chapter_index + 1000000
    WHERE book_id = p_book_id;

    -- Pass 2: assign sequential indices starting from 0, preserving order.
    UPDATE chapters
    SET chapter_index = subq.new_index
    FROM (
        SELECT id,
               (ROW_NUMBER() OVER (ORDER BY chapter_index ASC) - 1)::int AS new_index
        FROM chapters
        WHERE book_id = p_book_id
    ) subq
    WHERE chapters.id = subq.id;
END;
$$;
