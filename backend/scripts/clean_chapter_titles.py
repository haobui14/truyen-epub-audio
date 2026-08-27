"""Strip the author's release notes from chapter titles.

Scraped web-novel chapters carry the translator's/author's update notes inside
a trailing parenthetical on the title:

    Chương 619: Thổi một hơi (110, là 'thụy trì thiên hạ' tăng thêm 【 51120 】)
    Chương 141: Điều kiện của Máu Thợ Săn (410, thu đặt mua)

Everything from "(" onward is a subscription plea, a monthly-vote request, a
bonus-chapter credit or a "going to sleep now" aside -- not part of the title.

A keyword rule was tried first and rejected: of the 370 distinct tails in one
book, the ~37 it would have preserved were almost all junk too (`(810, nghỉ
ngơi)`, `(1015, đi ngủ)`, `(66, giao thừa vui vẻ!!)`, sponsor credits). In this
corpus a trailing parenthetical on a chapter title is a release note, full stop.

The same string also opens the chapter body, because split_text_by_headers
writes `title\\nbody`. Both get cleaned, so the reader doesn't show the junk
at the top of the page after the title was fixed.

DRY-RUN by default.

Usage (from backend/):
    python -m scripts.clean_chapter_titles <book_id|all>
    python -m scripts.clean_chapter_titles <book_id|all> --apply
"""
import argparse
import asyncio
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import get_client
from app.services import storage_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("app.services.storage_service").setLevel(logging.ERROR)
logger = logging.getLogger("clean_chapter_titles")

PAGE_SIZE = 500

# A trailing (...) group, ASCII or full-width. Body excludes parentheses so it
# can never swallow an earlier group.
_TRAILING_PAREN = re.compile(r"\s*[（(][^()（）]*[）)]\s*$")

# Refuse to reduce a title to nothing but its number.
_BARE_NUMBER = re.compile(r"^\s*Chương\s*\d+\s*[:.]?\s*$", re.IGNORECASE)


def clean_title(title: str) -> str:
    """Drop trailing parentheticals. Returns the original when the result would
    be empty or just 'Chương N:' -- a junk-looking tail is not worth losing the
    only text that identifies the chapter."""
    out = (title or "").strip()
    while True:
        stripped = _TRAILING_PAREN.sub("", out).strip()
        if stripped == out:
            break
        out = stripped
    if not out or _BARE_NUMBER.match(out):
        return (title or "").strip()
    return out


def _load_books(db, book_id: str) -> list[dict]:
    if book_id == "all":
        return db.table("books").select("id,title").order("created_at").execute().data or []
    row = db.table("books").select("id,title").eq("id", book_id).maybe_single().execute()
    if not row or not row.data:
        raise SystemExit(f"Book {book_id} not found")
    return [row.data]


def _load_chapters(db, book_id: str) -> list[dict]:
    rows: list[dict] = []
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
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


async def run(args: argparse.Namespace) -> None:
    db = get_client()
    books = _load_books(db, args.book_id)

    targets: list[tuple[str, dict, str]] = []
    for b in books:
        for ch in _load_chapters(db, b["id"]):
            new_title = clean_title(ch.get("title") or "")
            if new_title != (ch.get("title") or "").strip():
                targets.append((b["id"], ch, new_title))

    mode = "APPLY" if args.apply else "DRY RUN"
    logger.info(f"[{mode}] {len(targets)} titles to clean across {len(books)} book(s)")
    if not targets:
        logger.info("nothing to do")
        return

    logger.info("sample:")
    for _, ch, new_title in targets[:12]:
        logger.info(f"  {ch['title']!r}")
        logger.info(f"    -> {new_title!r}")

    if not args.apply:
        logger.info("DRY RUN — re-run with --apply to write the titles above.")
        return

    sem = asyncio.Semaphore(args.concurrency)
    counters = {"titles": 0, "bodies": 0, "failed": 0, "done": 0}

    async def clean_one(book_id: str, ch: dict, new_title: str) -> None:
        async with sem:
            try:
                old_title = (ch.get("title") or "").strip()
                update: dict = {"title": new_title}

                text = await storage_service.get_chapter_text_by_ids(
                    book_id, ch["id"], ch.get("updated_at")
                )
                # Only touch the body when its first line really is the old
                # title; anything else is content we have no business editing.
                if text:
                    lines = text.split("\n")
                    if lines and lines[0].strip() == old_title:
                        lines[0] = new_title
                        new_text = "\n".join(lines)
                        update["text_storage_path"] = (
                            await storage_service.upload_chapter_text(
                                book_id, ch["id"], new_text
                            )
                        )
                        update["word_count"] = (
                            len(new_text.split()) if new_text.strip() else 0
                        )
                        counters["bodies"] += 1

                await asyncio.to_thread(
                    lambda: db.table("chapters").update(update).eq("id", ch["id"]).execute()
                )
                counters["titles"] += 1
            except Exception as e:
                counters["failed"] += 1
                logger.warning(f"chapter {ch['id']} failed: {type(e).__name__}: {e}")
            finally:
                counters["done"] += 1
                if counters["done"] % 200 == 0:
                    logger.info(f"  {counters['done']}/{len(targets)}")

    await asyncio.gather(*(clean_one(bid, ch, t) for bid, ch, t in targets))

    logger.info(
        f"[{mode}] titles updated {counters['titles']}, "
        f"bodies rewritten {counters['bodies']}, failed {counters['failed']}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("book_id", help="UUID of the book, or 'all'")
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    ap.add_argument(
        "--concurrency", type=int, default=storage_service.STORAGE_CONCURRENCY,
        help="parallel Storage ops (default 8)",
    )
    args = ap.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
