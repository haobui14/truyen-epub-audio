"""One-shot backfill: re-encode existing book covers to bounded WebP.

New uploads are optimized at ingest by app/services/image_service.py; this
brings the covers that already exist in the `covers` bucket in line. Matters
most for the Android build, which renders covers UNOPTIMIZED (no Vercel
next/image), so phones download the raw stored bytes for every card.

Safe + reversible:
  * The ORIGINAL object is left in place (rollback = repoint books.cover_url).
  * The WebP is written to the normalized path {book_id}/cover.webp and
    books.cover_url is updated to its public URL + ?v= cache-buster.
  * Covers that can't be decoded, or that wouldn't shrink, are left untouched.

Idempotent: books whose cover_url already points at .webp are skipped, so
re-running is cheap.

Usage (from backend/):
    python -m scripts.optimize_covers                    # dry run, all books
    python -m scripts.optimize_covers --apply            # re-encode everything
    python -m scripts.optimize_covers --book-id <id>     # dry run, one book
    python -m scripts.optimize_covers --book-id <id> --apply
"""
import argparse
import logging
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import image_service
from app.services import storage_service as ss

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("optimize_covers")

BUCKET = "covers"


def _fmt(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _object_path(cover_url: str) -> str | None:
    """Extract the in-bucket object path from a stored public cover URL."""
    path = urlsplit(cover_url).path  # drops any ?v= etc.
    marker = f"/object/public/{BUCKET}/"
    if marker not in path:
        return None
    return unquote(path.split(marker, 1)[1])


def _download(path: str) -> bytes:
    """Fetch via the service-key HTTP/1.1 client (same client uploads use)."""
    def _do() -> bytes:
        resp = ss._get_direct_client().get(f"/object/{BUCKET}/{path}")
        if resp.status_code >= 400:
            raise ss.StorageUploadError(resp.status_code, resp.text, BUCKET, path)
        return resp.content
    return ss._retry_sync(_do, what=f"download {BUCKET}/{path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    parser.add_argument("--book-id", help="only this book")
    args = parser.parse_args()

    db = get_client()
    query = db.table("books").select("id,title,cover_url")
    if args.book_id:
        query = query.eq("id", args.book_id)
    books = [b for b in (query.execute().data or []) if b.get("cover_url")]
    logger.info("%d book(s) with a cover", len(books))

    done = skipped = failed = 0
    bytes_before = bytes_after = 0

    for book in books:
        title = (book.get("title") or "?")[:40]
        path = _object_path(book["cover_url"])
        if path is None:
            logger.warning("SKIP %s — cover_url not in the covers bucket: %s",
                           title, book["cover_url"])
            skipped += 1
            continue
        if path.endswith(".webp"):
            skipped += 1  # already optimized (new-format upload or prior run)
            continue

        try:
            original = _download(path)
        except Exception as e:
            logger.warning("FAIL %s — download %s: %s", title, path, e)
            failed += 1
            continue

        optimized = image_service.optimize_cover(original)
        if optimized is None:
            logger.info("KEEP %s — undecodable or already small (%s)",
                        title, _fmt(len(original)))
            skipped += 1
            continue

        data, content_type, ext = optimized
        new_path = f"{book['id']}/cover.{ext}"
        bytes_before += len(original)
        bytes_after += len(data)
        logger.info("%s %s — %s -> %s (%s)",
                    "OPT " if args.apply else "DRY ",
                    title, _fmt(len(original)), _fmt(len(data)), new_path)

        if not args.apply:
            done += 1
            continue

        try:
            ss._sync_upload(BUCKET, new_path, data, content_type)
            url = ss._get_storage().from_(BUCKET).get_public_url(new_path)
            db.table("books").update(
                {"cover_url": image_service.versioned_cover_url(url)}
            ).eq("id", book["id"]).execute()
            done += 1
        except Exception as e:
            logger.warning("FAIL %s — upload/update: %s", title, e)
            failed += 1

    verb = "re-encoded" if args.apply else "would re-encode"
    logger.info(
        "Summary: %s %d cover(s), skipped %d, failed %d — %s -> %s (saves %s)",
        verb, done, skipped, failed,
        _fmt(bytes_before), _fmt(bytes_after), _fmt(bytes_before - bytes_after),
    )
    if not args.apply:
        logger.info("Dry run — re-run with --apply to write. Originals are kept either way.")


if __name__ == "__main__":
    main()
