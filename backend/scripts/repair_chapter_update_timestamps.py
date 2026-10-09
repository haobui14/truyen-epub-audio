"""Remove import-derived chapter-update timestamps; preserve explicit additions.

Run from backend/:
    python -m scripts.repair_chapter_update_timestamps          # inspect
    python -m scripts.repair_chapter_update_timestamps --apply  # repair

Only books.last_chapter_added_at changes. A JSON backup is saved before writing,
and each update checks the original value so concurrent additions are preserved.
"""

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from app.database import get_client

logger = logging.getLogger(__name__)


def is_import_timestamp(update_stamp: str, latest_chapter_stamp: str) -> bool:
    # Append/manual-add handlers record the event AFTER the rows are inserted.
    # The old backfill equals an import date; a subsequent reparse can also leave
    # an earlier imported timestamp behind.
    return datetime.fromisoformat(update_stamp) <= datetime.fromisoformat(latest_chapter_stamp)


def inspect_timestamps(db) -> tuple[list[dict], list[dict]]:
    candidates = []
    preserved = []
    offset = 0
    page_size = 1000
    while True:
        rows = (
            db.table("books")
            .select("id,title,created_at,last_chapter_added_at")
            .order("id").range(offset, offset + page_size - 1).execute().data
        )
        for book in rows:
            stamp = book.get("last_chapter_added_at")
            if not stamp:
                continue
            latest = (
                db.table("chapters").select("created_at")
                .eq("book_id", book["id"]).order("created_at", desc=True)
                .limit(1).execute().data
            )
            if latest and is_import_timestamp(stamp, latest[0]["created_at"]):
                candidates.append(book)
            else:
                preserved.append(book)
        if len(rows) < page_size:
            return candidates, preserved
        offset += page_size


def apply_repairs(db, candidates: list[dict], backup_path: Path) -> int:
    if not candidates:
        return 0
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation avoids overwriting the recovery copy from a prior run.
    with backup_path.open("x", encoding="utf-8") as stream:
        json.dump(candidates, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    cleared = 0
    for book in candidates:
        result = (
            db.table("books").update({"last_chapter_added_at": None})
            .eq("id", book["id"])
            .eq("last_chapter_added_at", book["last_chapter_added_at"])
            .execute()
        )
        cleared += len(result.data or [])
    return cleared


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    db = get_client()
    candidates, preserved = inspect_timestamps(db)
    logger.info("Import-derived timestamps: %d; preserved additions: %d", len(candidates), len(preserved))
    # Report the books the old >24h homepage rule wrongly displayed.
    for book in candidates:
        gap = datetime.fromisoformat(book["last_chapter_added_at"]) - datetime.fromisoformat(book["created_at"])
        if gap.total_seconds() > 24 * 60 * 60:
            logger.info("False homepage update: %s", book["title"])
    for book in preserved:
        logger.info("Preserved: %s (%s)", book["title"], book["last_chapter_added_at"])
    if args.apply:
        run_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = Path(__file__).resolve().parent.parent / "backups" / f"chapter-update-timestamps-{run_stamp}.json"
        cleared = apply_repairs(db, candidates, backup)
        logger.info("Cleared %d timestamps; backup: %s", cleared, backup if candidates else "not needed")
    else:
        logger.info("Dry run; pass --apply to clear these timestamps.")


if __name__ == "__main__":
    main()
