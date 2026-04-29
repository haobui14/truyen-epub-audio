-- Run this in Supabase SQL Editor

-- ============================================================
-- Core content
-- ============================================================

CREATE TABLE IF NOT EXISTS books (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    author          TEXT,
    description     TEXT,
    cover_url       TEXT,
    voice           TEXT NOT NULL DEFAULT 'vi-VN-HoaiMyNeural',
    status          TEXT NOT NULL DEFAULT 'pending',
    total_chapters  INTEGER DEFAULT 0,
    is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
    featured_label  TEXT,
    story_status    TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (story_status IN ('ongoing', 'completed', 'unknown')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_books_created_at  ON books(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_status      ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_featured    ON books(is_featured) WHERE is_featured = TRUE;
CREATE INDEX IF NOT EXISTS idx_books_story_status ON books(story_status);

CREATE TABLE IF NOT EXISTS chapters (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id                 UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index           INTEGER NOT NULL,
    title                   TEXT NOT NULL,
    text_content            TEXT,
    word_count              INTEGER DEFAULT 0,
    status                  TEXT NOT NULL DEFAULT 'pending',
    error_message           TEXT,
    audio_url               TEXT,
    audio_storage_path      TEXT,
    audio_duration_seconds  FLOAT,
    audio_file_size_bytes   BIGINT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(book_id, chapter_index)
);

CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_chapters_status  ON chapters(book_id, status);

-- ============================================================
-- Users & auth
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    avatar_base64 TEXT,
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

-- User roles — to grant admin:
--   INSERT INTO user_roles (user_id, role) VALUES ('<uuid>', 'admin')
--   ON CONFLICT (user_id) DO UPDATE SET role = 'admin';
CREATE TABLE IF NOT EXISTS user_roles (
    user_id    UUID PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- User data
-- ============================================================

-- One row per user+book — tracks current chapter and scroll/audio position
CREATE TABLE IF NOT EXISTS user_progress (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL,
    book_id        UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id     UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    progress_value FLOAT NOT NULL DEFAULT 0,
    total_value    FLOAT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_user_progress_user_book    ON user_progress(user_id, book_id);
CREATE INDEX IF NOT EXISTS idx_user_progress_user_chapter ON user_progress(user_id, chapter_id);

-- Playback settings (speed, pitch) synced across devices
CREATE TABLE IF NOT EXISTS user_settings (
    user_id        UUID PRIMARY KEY,
    playback_rate  FLOAT NOT NULL DEFAULT 1,
    playback_pitch FLOAT NOT NULL DEFAULT 1,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Genres
-- ============================================================

CREATE TABLE IF NOT EXISTS genres (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT 'indigo',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS book_genres (
    book_id  UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    genre_id UUID NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, genre_id)
);

CREATE INDEX IF NOT EXISTS idx_book_genres_genre_id ON book_genres(genre_id);

-- ============================================================
-- XP / Leveling
-- ============================================================

-- One row per user. Deduplication is done via completed_listen_ids / completed_read_ids
-- text arrays — no separate completions table needed.
CREATE TABLE IF NOT EXISTS user_stats (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_exp               BIGINT NOT NULL DEFAULT 0,
    total_chapters_read     INTEGER NOT NULL DEFAULT 0,
    total_chapters_listened INTEGER NOT NULL DEFAULT 0,
    total_words_read        BIGINT NOT NULL DEFAULT 0,
    completed_read_ids      TEXT[] NOT NULL DEFAULT '{}',
    completed_listen_ids    TEXT[] NOT NULL DEFAULT '{}',
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Storage RLS policies
-- ============================================================

DROP POLICY IF EXISTS "Service role full access on epub-uploads" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access on audio"        ON storage.objects;
DROP POLICY IF EXISTS "Service role full access on covers"       ON storage.objects;
DROP POLICY IF EXISTS "Public read on audio"                     ON storage.objects;
DROP POLICY IF EXISTS "Public read on covers"                    ON storage.objects;

CREATE POLICY "Service role full access on epub-uploads"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'epub-uploads') WITH CHECK (bucket_id = 'epub-uploads');

CREATE POLICY "Service role full access on audio"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'audio') WITH CHECK (bucket_id = 'audio');

CREATE POLICY "Service role full access on covers"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'covers') WITH CHECK (bucket_id = 'covers');

-- The "audio" and "covers" buckets are flagged as public on the bucket
-- itself, so anyone with an object's path can fetch it via
-- /storage/v1/object/public/<bucket>/<path>. We deliberately do NOT add a
-- broad SELECT policy on storage.objects for them — that would also expose
-- the LIST endpoint and let clients enumerate every file (Supabase linter
-- 0025_public_bucket_allows_listing).

-- Storage buckets (create once in Supabase dashboard > Storage):
--   "epub-uploads" → private
--   "audio"        → public
--   "covers"       → public

-- ============================================================
-- Helper functions for chapter re-indexing
-- ============================================================

-- Note: every function below pins SET search_path = pg_catalog, public so that
-- a SECURITY DEFINER call cannot be hijacked by a malicious search_path
-- (Supabase linter 0011_function_search_path_mutable). EXECUTE on these
-- functions is also revoked from anon/authenticated/public at the bottom of
-- this file — only service_role and Postgres superusers may call them.

-- Make room for a new chapter inserted at p_insert_index by shifting everything above it up 1
CREATE OR REPLACE FUNCTION shift_chapters_up(p_book_id UUID, p_insert_index INT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE chapters SET chapter_index = chapter_index + 1000000
    WHERE book_id = p_book_id AND chapter_index >= p_insert_index;

    UPDATE chapters SET chapter_index = chapter_index - 1000000 + 1
    WHERE book_id = p_book_id AND chapter_index >= 1000000;
END;
$$;

-- Make room for p_n chapters inserted at p_insert_index (used by split-chapter)
CREATE OR REPLACE FUNCTION shift_chapters_up_by_n(p_book_id UUID, p_insert_index INT, p_n INT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE chapters SET chapter_index = chapter_index + 1000000
    WHERE book_id = p_book_id AND chapter_index >= p_insert_index;

    UPDATE chapters SET chapter_index = chapter_index - 1000000 + p_n
    WHERE book_id = p_book_id AND chapter_index >= 1000000;
END;
$$;

-- Close the gap left after a chapter is deleted
CREATE OR REPLACE FUNCTION reindex_chapters_after_delete(p_book_id UUID, p_deleted_index INT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE chapters SET chapter_index = -(chapter_index - 1)
    WHERE book_id = p_book_id AND chapter_index > p_deleted_index;

    UPDATE chapters SET chapter_index = -chapter_index
    WHERE book_id = p_book_id AND chapter_index < 0;
END;
$$;

-- Remove every occurrence of a literal string from all chapters of a book
CREATE OR REPLACE FUNCTION strip_string_from_book_chapters(p_book_id UUID, p_target TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE chapters
    SET
        text_content = replace(text_content, p_target, ''),
        word_count = CASE
            WHEN trim(replace(text_content, p_target, '')) = '' THEN 0
            ELSE cardinality(regexp_split_to_array(trim(replace(text_content, p_target, '')), '\s+'))
        END
    WHERE book_id = p_book_id
      AND text_content IS NOT NULL
      AND position(p_target IN text_content) > 0;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Resequence all chapters for a book starting from 0 (repair tool)
CREATE OR REPLACE FUNCTION reindex_all_chapters(p_book_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE chapters SET chapter_index = chapter_index + 1000000
    WHERE book_id = p_book_id;

    UPDATE chapters SET chapter_index = subq.new_index
    FROM (
        SELECT id,
               (ROW_NUMBER() OVER (ORDER BY chapter_index ASC) - 1)::int AS new_index
        FROM chapters WHERE book_id = p_book_id
    ) subq
    WHERE chapters.id = subq.id;
END;
$$;

-- ============================================================
-- Row Level Security
-- ============================================================
-- The backend connects with the service_role key (see
-- backend/app/database.py), which bypasses RLS by design.
-- The frontend never connects to Supabase directly — all data
-- access goes through the FastAPI backend. Auth is custom JWT,
-- not Supabase Auth, so auth.uid() cannot be used in policies.
--
-- Therefore we enable RLS on every public table with NO policies.
-- This denies all access from the anon and authenticated PostgREST
-- roles (which is what we want) while leaving service_role
-- unaffected. This closes the Supabase database linter warnings
-- 0013_rls_disabled_in_public and 0023_sensitive_columns_exposed.

ALTER TABLE books            ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapters         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_progress    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_stats       ENABLE ROW LEVEL SECURITY;
ALTER TABLE genres           ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_genres      ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Revoke discovery & RPC from anon / authenticated
-- ============================================================
-- RLS already blocks data reads from anon/authenticated, but the bare
-- SELECT grants on these tables (and EXECUTE on the helper functions)
-- still expose the schema via PostgREST/pg_graphql:
--   0026_pg_graphql_anon_table_exposed
--   0027_pg_graphql_authenticated_table_exposed
--   0028_anon_security_definer_function_executable
--   0029_authenticated_security_definer_function_executable
--
-- Since only the FastAPI backend (service_role) ever queries this DB,
-- we revoke these privileges entirely. service_role and the postgres
-- superuser keep their default access.

REVOKE SELECT ON
    books, chapters, users, refresh_tokens,
    user_roles, user_progress, user_settings, user_stats,
    genres, book_genres
FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION
    shift_chapters_up(UUID, INT),
    shift_chapters_up_by_n(UUID, INT, INT),
    reindex_chapters_after_delete(UUID, INT),
    strip_string_from_book_chapters(UUID, TEXT),
    reindex_all_chapters(UUID)
FROM PUBLIC, anon, authenticated;
