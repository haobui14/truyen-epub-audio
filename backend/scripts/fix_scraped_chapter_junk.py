"""Remove the scraped site's furniture from stored chapter text.

Scraped source files print a chapter's title two or three times (breadcrumb,
page heading, body heading). The TXT splitter kept the extra copies as body
text, so every chapter opened with its own title again — under the title the
reader already shows. One 243-chapter book had all 243 affected.

Chapters also END with the site's block: a dot separator, an "(end of
chapter)" marker, a keyboard-navigation hint, an upload credit and the book
title, plus the author's update note. app/services/epub_parser.py now strips
both ends on import; this rewrites books imported before that.

Only leading lines that repeat the chapter's own title are removed, comparing
case- and spacing-insensitively; nothing else in the text is touched, and a
chapter that would end up empty is left alone.

DRY-RUN by default. chapters.word_count is refreshed for rewritten chapters,
which also bumps updated_at — the version key chapter-text reads are cached by.

Usage (from backend/):
    python -m scripts.fix_scraped_chapter_junk <book_id>
    python -m scripts.fix_scraped_chapter_junk <book_id> --apply
    python -m scripts.fix_scraped_chapter_junk all          # scan every book
"""
import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service, text_cleanup

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

logging.basicConfig(level=logging.INFO, format="%(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("fix_duplicate_titles")

PAGE_SIZE = 1000


# The rule lives in app/services/text_cleanup so the EPUB importer and this
# repair use exactly the same definition of a chapter's header block.
strip_repeated_title = text_cleanup.strip_leading_title


def load_books(db, book_id: str) -> list[dict]:
    if book_id != "all":
        rows = db.table("books").select("id,title").eq("id", book_id).execute().data
        if not rows:
            raise SystemExit(f"Book {book_id} not found")
        return rows
    out: list[dict] = []
    offset = 0
    while True:
        page = (
            db.table("books").select("id,title").order("created_at")
            .range(offset, offset + PAGE_SIZE - 1).execute().data
        )
        out.extend(page)
        if len(page) < PAGE_SIZE:
            return out
        offset += PAGE_SIZE


def load_chapters(db, book_id: str) -> list[dict]:
    out: list[dict] = []
    offset = 0
    while True:
        page = (
            db.table("chapters")
            .select("id,chapter_index,title,updated_at,text_storage_path")
            .eq("book_id", book_id).order("chapter_index")
            .range(offset, offset + PAGE_SIZE - 1).execute().data
        )
        out.extend(page)
        if len(page) < PAGE_SIZE:
            return out
        offset += PAGE_SIZE


async def process_book(db, book: dict, apply: bool, show: int) -> tuple[int, int]:
    chapters = load_chapters(db, book["id"])
    fixed = 0
    samples: list[str] = []
    semaphore = asyncio.Semaphore(8)

    async def handle(row: dict) -> None:
        nonlocal fixed
        path = row.get("text_storage_path")
        if not path or not row.get("title"):
            return
        async with semaphore:
            try:
                text = await storage_service.download_chapter_text(path, row["updated_at"])
            except Exception as exc:  # a missing object must not stop the run
                logger.warning("  chapter %s: read failed (%s)", row["chapter_index"] + 1, exc)
                return
            new_text, removed = strip_repeated_title(text, row["title"])
            new_text, trailing = text_cleanup.strip_trailing_boilerplate(new_text)
            removed += trailing
            if not removed:
                return
            fixed += 1
            if len(samples) < show:
                samples.append(
                    f"    ch {row['chapter_index'] + 1}: removed {removed} line(s); "
                    f"starts {new_text[:46]!r} … ends {new_text[-40:]!r}"
                )
            if apply:
                await storage_service.upload_chapter_text(book["id"], row["id"], new_text)
                try:
                    db.table("chapters").update({"word_count": len(new_text.split())}).eq(
                        "id", row["id"]
                    ).execute()
                except Exception as exc:
                    logger.warning("  chapter %s: word_count update failed (%s)", row["chapter_index"] + 1, exc)

    await asyncio.gather(*(handle(row) for row in chapters))
    if fixed:
        logger.info(
            "%s — %d of %d chapter(s) %s",
            book["title"], fixed, len(chapters), "rewritten" if apply else "would be rewritten",
        )
        for sample in samples:
            logger.info(sample)
    return fixed, len(chapters)


async def run(args: argparse.Namespace) -> None:
    db = get_client()
    books = load_books(db, args.book_id)
    logger.info("Scanning %d book(s)%s\n", len(books), "" if args.apply else " (dry run)")
    total_fixed = total_chapters = books_hit = 0
    for book in books:
        fixed, count = await process_book(db, book, args.apply, args.show)
        total_fixed += fixed
        total_chapters += count
        books_hit += 1 if fixed else 0
    logger.info(
        "\n%d chapter(s) in %d book(s) %s (of %d scanned)",
        total_fixed, books_hit,
        "rewritten" if args.apply else "would be rewritten", total_chapters,
    )
    if total_fixed and not args.apply:
        logger.info("DRY RUN — nothing written. Re-run with --apply.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("book_id", help="book UUID, or 'all' to scan every book")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--show", type=int, default=3, help="sample chapters to print per book (default: 3)")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
