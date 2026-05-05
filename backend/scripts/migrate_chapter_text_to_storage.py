"""One-shot migration: move chapters.text_content into Supabase Storage.

For every row where text_storage_path IS NULL AND text_content IS NOT NULL:
    1. Upload text_content to chapter-text/{book_id}/{chapter_id}.txt
    2. UPDATE chapters SET text_storage_path = path, text_content = NULL

Uses a thread pool because storage3 and supabase-py are sync; asyncio.gather
on top of sync HTTP doesn't give real parallelism. Idempotent — safe to re-run.

After all rows are migrated, run:

    ALTER TABLE chapters DROP COLUMN text_content;
    DROP FUNCTION IF EXISTS strip_string_from_book_chapters(UUID, TEXT);
    VACUUM FULL chapters;

Usage (from backend/):
    python -m scripts.migrate_chapter_text_to_storage
"""
import logging
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services.storage_service import (
    CHAPTER_TEXT_BUCKET,
    _get_storage,
    chapter_text_path,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrate_chapter_text")

PAGE_SIZE = 500
WORKERS = 8           # Windows socket pool + Supabase Storage limits favor low concurrency
MAX_RETRIES = 4       # per phase (upload, db update)


def _retry(fn, what: str):
    """Run fn() with exponential backoff on transient errors. Returns the
    result, or raises the last exception."""
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            return fn()
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            transient = (
                "10035" in msg
                or "timeout" in msg
                or "timed out" in msg
                or "databasetimeout" in msg
                or "response" in msg and "not associated" in msg
                or "connection" in msg
                or "remote" in msg and "disconnect" in msg
                or "429" in msg
                or "503" in msg
                or "502" in msg
            )
            if not transient or attempt == MAX_RETRIES - 1:
                raise
            sleep = (2 ** attempt) + random.uniform(0, 0.5)
            time.sleep(sleep)
    raise last_err  # unreachable


def migrate_one(ch: dict) -> tuple[str, bool, str | None]:
    """Returns (chapter_id, uploaded, error_message)."""
    db = get_client()
    storage = _get_storage()
    chapter_id = ch["id"]
    book_id = ch["book_id"]
    text = ch.get("text_content") or ""

    if not text:
        try:
            _retry(
                lambda: db.table("chapters").update({"text_content": None}).eq("id", chapter_id).execute(),
                "clear-empty",
            )
            return (chapter_id, False, None)
        except Exception as e:
            return (chapter_id, False, f"clear-empty failed: {e}")

    path = chapter_text_path(book_id, chapter_id)
    try:
        _retry(
            lambda: storage.from_(CHAPTER_TEXT_BUCKET).upload(
                path=path,
                file=text.encode("utf-8"),
                file_options={"content-type": "text/plain; charset=utf-8", "upsert": "true"},
            ),
            "upload",
        )
    except Exception as e:
        return (chapter_id, False, f"upload failed: {e}")

    try:
        _retry(
            lambda: db.table("chapters").update({
                "text_storage_path": path,
                "text_content": None,
            }).eq("id", chapter_id).execute(),
            "db update",
        )
    except Exception as e:
        return (chapter_id, False, f"db update failed: {e}")

    return (chapter_id, True, None)


def main() -> None:
    db = get_client()
    # Warm singletons before threads race for them.
    _get_storage()

    # How many to migrate (for progress reporting). Limit(1) keeps the
    # response body tiny — we only care about the count header.
    total_remaining = (
        db.table("chapters")
        .select("id", count="exact")
        .is_("text_storage_path", "null")
        .not_.is_("text_content", "null")
        .limit(1)
        .execute()
        .count
        or 0
    )
    logger.info(f"Found {total_remaining:,} chapters to migrate. Workers={WORKERS}, page_size={PAGE_SIZE}.")
    if total_remaining == 0:
        return

    started = time.monotonic()
    total_migrated = 0
    total_failed = 0
    page = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while True:
            # Always fetch from offset 0: as we update text_content=NULL the rows
            # drop out of the result set, so the "next" page is still at the start.
            result = (
                db.table("chapters")
                .select("id,book_id,text_content")
                .is_("text_storage_path", "null")
                .not_.is_("text_content", "null")
                .limit(PAGE_SIZE)
                .execute()
            )
            rows = result.data or []
            if not rows:
                break
            page += 1
            page_started = time.monotonic()

            futures = [pool.submit(migrate_one, ch) for ch in rows]
            page_ok = 0
            page_fail = 0
            for fut in as_completed(futures):
                _id, uploaded, err = fut.result()
                if err:
                    page_fail += 1
                    logger.warning(f"  chapter {_id}: {err}")
                elif uploaded:
                    page_ok += 1

            total_migrated += page_ok
            total_failed += page_fail
            elapsed = time.monotonic() - started
            page_secs = time.monotonic() - page_started
            done = total_migrated + total_failed
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total_remaining - done) / rate if rate > 0 else 0
            logger.info(
                f"Page {page}: +{page_ok} ok, {page_fail} fail in {page_secs:.1f}s "
                f"| total {done:,}/{total_remaining:,} ({rate:.1f}/s, ETA {eta/60:.1f}m)"
            )

    logger.info(f"Done. {total_migrated:,} migrated, {total_failed:,} failed in {(time.monotonic()-started)/60:.1f}m.")


if __name__ == "__main__":
    main()
