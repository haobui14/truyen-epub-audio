"""One-shot storage cleanup. DRY-RUN unless --apply is passed.

Two independent jobs:

  1. chapter-text orphans
     Delete objects in the `chapter-text` bucket whose chapter_id no longer
     exists in the `chapters` table. These pile up because book deletes,
     reparses, and auto-splits clean storage on a best-effort basis — a single
     failed delete leaves the .txt behind forever.

  2. epub-uploads (delete EVERYTHING)
     Wipe the `epub-uploads` bucket (the original uploaded files).
     ⚠️  After this, the admin "Phân tích lại" (reparse) button stops working,
         since it re-parses from these stored originals.

Bucket layout is one level deep — `{book_id}/{filename}`:
    chapter-text : {book_id}/{chapter_id}.txt
    epub-uploads : {book_id}/original.<ext>

Usage (from backend/):
    python -m scripts.cleanup_storage                       # dry run, both jobs
    python -m scripts.cleanup_storage --apply               # delete, both jobs
    python -m scripts.cleanup_storage --only chapter-text   # dry run, one job
    python -m scripts.cleanup_storage --only epub-uploads --apply
"""
import argparse
import logging
import sys
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service
from app.services.storage_service import CHAPTER_TEXT_BUCKET

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("cleanup_storage")

EPUB_BUCKET = "epub-uploads"
LIST_PAGE = 1000
DELETE_BATCH = 200


def _fmt_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def list_all_objects(bucket: str):
    """Yield (path, size_bytes) for every file in the bucket.

    Lists the bucket root to discover `{book_id}` folders (folder entries have
    id == None), then pages through each folder's files."""
    folders: list[str] = []
    offset = 0
    while True:
        entries = storage_service._sync_list(bucket, "", limit=LIST_PAGE, offset=offset)
        if not entries:
            break
        for e in entries:
            if e.get("id") is None:
                folders.append(e["name"])  # a {book_id} folder
            else:
                # stray file directly at root (not expected) — account for it
                size = int((e.get("metadata") or {}).get("size") or 0)
                yield e["name"], size
        if len(entries) < LIST_PAGE:
            break
        offset += LIST_PAGE

    for book_id in folders:
        f_offset = 0
        while True:
            files = storage_service._sync_list(
                bucket, book_id, limit=LIST_PAGE, offset=f_offset
            )
            if not files:
                break
            for f in files:
                if f.get("id") is None:
                    continue  # nested folder (not expected at this depth)
                size = int((f.get("metadata") or {}).get("size") or 0)
                yield f"{book_id}/{f['name']}", size
            if len(files) < LIST_PAGE:
                break
            f_offset += LIST_PAGE


def load_valid_chapter_ids() -> set[str]:
    """Every chapter_id currently in the DB. Ordered pagination keeps the page
    window stable as we walk all rows."""
    db = get_client()
    ids: set[str] = set()
    PAGE = 1000
    offset = 0
    while True:
        rows = (
            db.table("chapters")
            .select("id")
            .order("id")
            .range(offset, offset + PAGE - 1)
            .execute()
            .data
            or []
        )
        if not rows:
            break
        ids.update(r["id"] for r in rows)
        if len(rows) < PAGE:
            break
        offset += PAGE
    return ids


def delete_paths(bucket: str, paths: list[str]) -> None:
    for i in range(0, len(paths), DELETE_BATCH):
        batch = paths[i:i + DELETE_BATCH]
        storage_service._sync_remove(bucket, batch)
        logger.info(f"  deleted {min(i + DELETE_BATCH, len(paths)):,}/{len(paths):,}")


def clean_chapter_text(apply: bool) -> None:
    logger.info("=== chapter-text orphans ===")
    valid = load_valid_chapter_ids()
    logger.info(f"valid chapters in DB : {len(valid):,}")

    total = 0
    total_size = 0
    orphan_paths: list[str] = []
    orphan_size = 0
    for path, size in list_all_objects(CHAPTER_TEXT_BUCKET):
        total += 1
        total_size += size
        fname = path.rsplit("/", 1)[-1]
        chapter_id = fname[:-4] if fname.endswith(".txt") else fname
        if chapter_id not in valid:
            orphan_paths.append(path)
            orphan_size += size
        if total % 20000 == 0:
            logger.info(f"  scanned {total:,} objects…")

    logger.info(f"objects in bucket    : {total:,} ({_fmt_size(total_size)})")
    logger.info(f"ORPHANS to delete    : {len(orphan_paths):,} ({_fmt_size(orphan_size)})")
    if orphan_paths:
        logger.info(f"  examples: {orphan_paths[:3]}")

    if apply and orphan_paths:
        logger.info(f"Deleting {len(orphan_paths):,} orphan objects…")
        delete_paths(CHAPTER_TEXT_BUCKET, orphan_paths)
        logger.info("chapter-text cleanup complete.")
    elif not apply:
        logger.info("DRY RUN — pass --apply to delete the orphans above.")


def clean_epub_uploads(apply: bool) -> None:
    logger.info("=== epub-uploads (delete ALL) ===")
    paths: list[str] = []
    total_size = 0
    for path, size in list_all_objects(EPUB_BUCKET):
        paths.append(path)
        total_size += size
    logger.info(f"objects in bucket    : {len(paths):,} ({_fmt_size(total_size)})")
    if paths:
        logger.info(f"  examples: {paths[:3]}")

    if apply and paths:
        logger.info(f"Deleting ALL {len(paths):,} epub-uploads objects…")
        delete_paths(EPUB_BUCKET, paths)
        logger.info("epub-uploads cleanup complete.")
    elif not apply:
        logger.info("DRY RUN — pass --apply to delete everything above.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    ap.add_argument(
        "--only",
        choices=["chapter-text", "epub-uploads"],
        help="run only one job (default: both)",
    )
    args = ap.parse_args()

    logger.info("Mode: %s", "APPLY (deleting)" if args.apply else "DRY RUN (report only)")
    storage_service._get_storage()  # warm singleton

    if args.only in (None, "chapter-text"):
        clean_chapter_text(args.apply)
    if args.only in (None, "epub-uploads"):
        clean_epub_uploads(args.apply)

    logger.info("Done.")


if __name__ == "__main__":
    main()
