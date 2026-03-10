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
