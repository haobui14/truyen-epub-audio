"""One-shot migration: gzip-compress existing chapter-text objects in place.

Chapter text is now stored gzip-compressed by storage_service.upload_chapter_text().
This recompresses the ~87k legacy plain-UTF-8 objects so the bucket shrinks ~3x
(measured: ~916 MB -> ~320 MB).

Transparent + safe:
  * Same object path ({book_id}/{chapter_id}.txt) — no DB change.
  * Re-uploads with Content-Type "application/gzip" (NEVER Content-Encoding).
  * download_chapter_text detects gzip by magic bytes, so this can run gradually
    against the live (gzip-aware) backend with zero downtime.

⚠️  DEPLOY THE GZIP-AWARE BACKEND (storage_service.py) BEFORE RUNNING --apply.
    The old backend would .decode('utf-8') gzip bytes and serve empty chapters.

Idempotent + resumable: objects already stored as application/gzip (cheap skip via
list metadata) or detected as gzip by magic bytes (after download) are skipped, so
re-running is cheap and safe — and catches any chapters written during a prior run.

Usage (from backend/):
    python -m scripts.compress_chapter_text                  # dry run, whole bucket
    python -m scripts.compress_chapter_text --apply          # compress everything
    python -m scripts.compress_chapter_text --book-id <id>   # dry run, one book
    python -m scripts.compress_chapter_text --book-id <id> --apply
    python -m scripts.compress_chapter_text --apply --workers 8
"""
import argparse
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import storage_service as ss
from app.services.storage_service import CHAPTER_TEXT_BUCKET

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("compress_chapter_text")

LIST_PAGE = 1000
CHUNK = 2000  # objects submitted to the pool per wave (bounds in-flight futures)
GZIP_MIME = "application/gzip"


def _download_http1(path: str) -> bytes:
    """Download a chapter-text object over the HTTP/1.1 upload client instead of
    storage3's shared HTTP/2 connection.

    storage3's `.download()` multiplexes all concurrent downloads onto ONE HTTP/2
    connection; under our 8-way fan-out Supabase drops the stream, tripping
    storage3's `UnboundLocalError: ... 'response'` bug on nearly every request
    (it recovers via retry but halves throughput). The HTTP/1.1 client gives each
    request its own socket — the same fix storage_service uses for uploads
    (see storage_service.py:45-50). Production reads are unchanged.

    Objects are stored with Content-Type application/gzip and NO Content-Encoding,
    so httpx returns the raw gzip bytes (no auto-decompression)."""
    def _do() -> bytes:
        resp = ss._get_upload_client().get(f"/object/{CHAPTER_TEXT_BUCKET}/{path}")
        if resp.status_code >= 400:
            raise ss.StorageUploadError(resp.status_code, resp.text, CHAPTER_TEXT_BUCKET, path)
        return resp.content
    return ss._retry_sync(_do, what=f"download {CHAPTER_TEXT_BUCKET}/{path}")


def _fmt(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def list_objects(book_id: str | None):
    """Yield (path, metadata_dict) for every file in chapter-text (or one book).

    Same two-level listing as cleanup_storage.py: list root for {book_id} folders
    (folder entries have id == None), then page through each folder's files."""
    if book_id:
        folders = [book_id]
    else:
        folders = []
        offset = 0
        while True:
            entries = ss._sync_list(CHAPTER_TEXT_BUCKET, "", limit=LIST_PAGE, offset=offset)
            if not entries:
                break
            for e in entries:
                if e.get("id") is None:
                    folders.append(e["name"])
            if len(entries) < LIST_PAGE:
                break
            offset += LIST_PAGE

    for folder in folders:
        f_offset = 0
        while True:
            files = ss._sync_list(CHAPTER_TEXT_BUCKET, folder, limit=LIST_PAGE, offset=f_offset)
            if not files:
                break
            for f in files:
                if f.get("id") is None:
                    continue  # nested folder (not expected at this depth)
                yield f"{folder}/{f['name']}", (f.get("metadata") or {})
            if len(files) < LIST_PAGE:
                break
            f_offset += LIST_PAGE


def compress_one(path: str, metadata: dict, apply: bool):
    """Returns (status, size_before, size_after, error).
    status in {already, empty, dry_run, compressed, error}."""
    try:
        # Cheap skip — no download — for objects already stored as gzip.
        if metadata.get("mimetype") == GZIP_MIME:
            return ("already", 0, 0, None)
        data = _download_http1(path)  # HTTP/1.1 — avoids storage3's HTTP/2 stream bug
        # Authoritative skip (handles missing/stale list metadata).
        if ss._is_gzip(data):
            return ("already", 0, 0, None)
        if len(data) == 0:
            # gzip(b"") would be ~20 bytes — bigger. Leave empties as-is; they
            # read back as "" either way.
            return ("empty", 0, 0, None)
        gz = ss._gzip_compress(data)
        before, after = len(data), len(gz)
        if not apply:
            return ("dry_run", before, after, None)
        ss._sync_upload(CHAPTER_TEXT_BUCKET, path, gz, GZIP_MIME)  # retried internally
        return ("compressed", before, after, None)
    except Exception as e:
        return ("error", 0, 0, f"{type(e).__name__}: {e}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--apply", action="store_true", help="actually compress (default: dry run)")
    ap.add_argument("--workers", type=int, default=ss.STORAGE_CONCURRENCY,
                    help=f"concurrent workers (default {ss.STORAGE_CONCURRENCY})")
    ap.add_argument("--book-id", help="process a single book folder (smoke test)")
    args = ap.parse_args()

    logger.info(
        "Mode: %s | workers=%d%s",
        "APPLY (compressing)" if args.apply else "DRY RUN (report only)",
        args.workers,
        f" | book={args.book_id}" if args.book_id else "",
    )
    ss._get_storage()        # warm singletons before threads race for them
    ss._get_upload_client()

    logger.info("Enumerating objects…")
    objects = list(list_objects(args.book_id))
    total = len(objects)
    logger.info("Found %s objects.", f"{total:,}")
    if total == 0:
        return

    started = time.monotonic()
    done = n_compressed = n_already = n_empty = n_error = 0
    raw_total = gz_total = 0

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i in range(0, total, CHUNK):
            batch = objects[i:i + CHUNK]
            futures = [pool.submit(compress_one, p, m, args.apply) for p, m in batch]
            for fut in as_completed(futures):
                status, before, after, err = fut.result()
                done += 1
                if status in ("compressed", "dry_run"):
                    n_compressed += 1
                    raw_total += before
                    gz_total += after
                elif status == "already":
                    n_already += 1
                elif status == "empty":
                    n_empty += 1
                elif status == "error":
                    n_error += 1
                    logger.warning("  error: %s", err)

            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed else 0
            eta = (total - done) / rate if rate else 0
            saved = raw_total - gz_total
            logger.info(
                "Progress %s/%s | %.0f/s ETA %.1fm | compress=%s already=%s empty=%s err=%s | saved %s (%.0f%%)",
                f"{done:,}", f"{total:,}", rate, eta / 60,
                f"{n_compressed:,}", f"{n_already:,}", f"{n_empty:,}", f"{n_error:,}",
                _fmt(saved), (100 * saved / raw_total) if raw_total else 0,
            )

    saved = raw_total - gz_total
    logger.info("-" * 60)
    logger.info(
        "%s: compress=%s already=%s empty=%s error=%s",
        "Would compress" if not args.apply else "Compressed",
        f"{n_compressed:,}", f"{n_already:,}", f"{n_empty:,}", f"{n_error:,}",
    )
    if raw_total:
        logger.info(
            "compressed set: %s -> %s  (saved %s, %.0f%%)",
            _fmt(raw_total), _fmt(gz_total), _fmt(saved), 100 * saved / raw_total,
        )
    if not args.apply:
        logger.info("DRY RUN — pass --apply to compress.")
    logger.info("Done in %.1fm.", (time.monotonic() - started) / 60)


if __name__ == "__main__":
    main()
