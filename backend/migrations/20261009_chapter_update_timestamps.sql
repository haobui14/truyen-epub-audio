-- Clear the old max(chapters.created_at) backfill. Explicit chapter additions
-- record their timestamp after inserting rows and are preserved. Imported or
-- rebuilt chapter rows alone do not prove a story received new chapters.
-- Run in the Supabase SQL editor; idempotent.
UPDATE books b SET last_chapter_added_at = NULL
FROM (SELECT book_id, max(created_at) AS max_created FROM chapters GROUP BY book_id) c
WHERE c.book_id = b.id AND b.last_chapter_added_at <= c.max_created;
