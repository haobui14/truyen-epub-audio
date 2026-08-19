"""Export one book's chapters to a single UTF-8 .txt file.

Mirrors the /api/books/{id}/epub export: all chapters in chapter_index order,
text pulled from the chapter-text bucket via get_chapter_text_by_ids (gzip-aware,
version-keyed with the row's updated_at so the CDN can't serve stale bytes).

Usage (from backend/):
    python -m scripts.export_book_txt <book_id>                # <title>.txt in CWD
    python -m scripts.export_book_txt <book_id> -o C:\\some\\dir  # <title>.txt in dir
    python -m scripts.export_book_txt <book_id> -o out.txt     # exact file path
"""
import argparse
import asyncio
import logging
import re
import sys
from pathlib import Path

# Make `app.*` imports work when run as `python -m scripts.…`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("export_book_txt")

PAGE_SIZE = 500


def safe_filename(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|\r\n]+', " ", title).strip() or "truyen"


async def export_book(book_id: str, output_arg: str | None) -> Path:
    db = get_client()
    book = (
        db.table("books")
        .select("id,title,author")
        .eq("id", book_id)
        .maybe_single()
        .execute()
    )
    if not book or not book.data:
        raise SystemExit(f"Book {book_id} not found")

    chapters: list[dict] = []
    offset = 0
    while True:
        page = (
            db.table("chapters")
            .select("id,chapter_index,title,updated_at")
            .eq("book_id", book_id)
            .order("chapter_index")
            .range(offset, offset + PAGE_SIZE - 1)
            .execute()
        )
        batch = page.data or []
        chapters.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    if not chapters:
        raise SystemExit(f"Book {book_id} has no chapters")

    title = book.data.get("title") or "Truyện"
    author = book.data.get("author")
    logger.info(f"Exporting '{title}' — {len(chapters)} chapters")

    sem = asyncio.Semaphore(storage_service.STORAGE_CONCURRENCY)
    done = 0

    async def fetch_text(ch: dict) -> str:
        nonlocal done
        async with sem:
            text = await storage_service.get_chapter_text_by_ids(
                book_id, ch["id"], ch.get("updated_at")
            )
        done += 1
        if done % 100 == 0 or done == len(chapters):
            logger.info(f"  fetched {done}/{len(chapters)}")
        return text

    texts = await asyncio.gather(*(fetch_text(ch) for ch in chapters))

    empty = [ch["title"] for ch, t in zip(chapters, texts) if not t.strip()]
    if empty:
        logger.warning(
            f"{len(empty)} chapter(s) had no text, placeholder written: {empty[:5]}"
        )

    out = Path(output_arg) if output_arg else Path.cwd()
    if out.is_dir() or (output_arg or "").endswith(("\\", "/")):
        out = out / f"{safe_filename(title)}.txt"
    out.parent.mkdir(parents=True, exist_ok=True)

    # utf-8-sig: BOM helps older Windows editors auto-detect the encoding.
    with open(out, "w", encoding="utf-8-sig") as f:
        f.write(f"{title}\n")
        if author:
            f.write(f"Tác giả: {author}\n")
        f.write(f"Số chương: {len(chapters)}\n")
        for ch, text in zip(chapters, texts):
            title_line = ch["title"].strip()
            body = text.strip()
            # Parsed chapter text usually repeats its own title as the first
            # line — drop it so the heading isn't printed twice.
            first, _, rest = body.partition("\n")
            if first.strip().casefold() == title_line.casefold():
                body = rest.strip()
            f.write(f"\n\n{title_line}\n\n")
            f.write(body or "(Chương này chưa có nội dung)")
        f.write("\n")

    size_mb = out.stat().st_size / (1024 * 1024)
    logger.info(f"Wrote {out} ({size_mb:.1f} MB)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("book_id", help="UUID of the book to export")
    ap.add_argument(
        "-o", "--output",
        help="output .txt path, or a directory to place <title>.txt in (default: CWD)",
    )
    args = ap.parse_args()
    asyncio.run(export_book(args.book_id, args.output))


if __name__ == "__main__":
    main()
