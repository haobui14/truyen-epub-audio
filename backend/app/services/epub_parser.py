import asyncio
import os
import re
import tempfile
import uuid
import logging
from pathlib import Path
from typing import Optional

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

from app.database import get_client
from app.utils.text_cleaner import html_to_text
from app.services import storage_service, task_queue

logger = logging.getLogger(__name__)

_CHAPTER_HEADER_RE = re.compile(
    r'^(?:\d+\.\s*)?'          # optional leading "3. " numbering
    r'(chương|chapter)'        # the keyword
    r'\s+\d+',                 # followed by a chapter number
    re.IGNORECASE
)


def split_text_by_headers(text: str) -> list[dict]:
    """Split text into parts by Chương/Chapter headers.

    All text before the first header (preamble, separator lines between EPUB
    spine items, etc.) is prepended to the first real chapter's body so it is
    never lost and never counted as a spurious extra chapter.

    Returns a list of dicts: {title, text_content, has_body}.
    has_body is False when a header was detected but the body is empty.
    """
    lines = text.split("\n")
    parts: list[dict] = []
    current_title = ""
    buf: list[str] = []

    def flush() -> None:
        body = "\n".join(buf).strip()
        if current_title:
            parts.append({
                "title": current_title,
                "text_content": f"{current_title}\n{body}".strip(),
                "has_body": bool(body),
            })
        elif body:
            # Pre-header content — tag it so we can merge it into the first
            # real chapter rather than treating it as a standalone entry.
            parts.append({"_pre": body})

    for line in lines:
        if _CHAPTER_HEADER_RE.match(line.strip()):
            flush()
            current_title = line.strip()
            buf = []
        else:
            buf.append(line)
    flush()

    # Merge any leading preamble into the first real chapter's body.
    # If there are no real chapters at all, drop the preamble entirely.
    if parts and "_pre" in parts[0]:
        pre = parts.pop(0)["_pre"]
        if parts:
            p = parts[0]
            p["text_content"] = (pre + "\n" + p["text_content"]).strip()
            p["has_body"] = True

    return parts


def auto_split_chapters(chapters_data: list[dict]) -> tuple[list[dict], list[str]]:
    """Join all chapter text and re-split by chapter headers.

    Only replaces chapters_data when more chapters are detected (i.e. the EPUB
    had multiple chapters merged into a single spine item).

    Returns:
        (new_chapters_data, missing_titles) — missing_titles are headers with
        no body text between them and the next header.
    """
    if not chapters_data:
        return chapters_data, []

    book_id = chapters_data[0]["book_id"]
    # Join with a single newline so there is always a line break between
    # adjacent chapters even when text_content has no trailing newline.
    combined = "\n".join((ch.get("text_content") or "") for ch in chapters_data)
    parts = split_text_by_headers(combined)

    # Only apply when we find strictly more chapters (merged EPUB items)
    if len(parts) <= len(chapters_data):
        return chapters_data, []

    missing_titles = [p["title"] for p in parts if not p["has_body"]]
    new_chapters = [
        {
            "id": str(uuid.uuid4()),
            "book_id": book_id,
            "chapter_index": i,
            "title": p["title"],
            "text_content": p["text_content"],
            "word_count": len(p["text_content"].split()),
            "status": "pending",
        }
        for i, p in enumerate(parts)
    ]

    logger.info(
        f"Auto-split: {len(chapters_data)} EPUB items → {len(new_chapters)} chapters"
        + (f", {len(missing_titles)} missing body" if missing_titles else "")
    )
    return new_chapters, missing_titles

VALID_MEDIA_TYPES = {ebooklib.ITEM_DOCUMENT}


def _extract_chapter_title(soup: BeautifulSoup, fallback: str) -> str:
    for tag in ["h1", "h2", "h3"]:
        el = soup.find(tag)
        if el and el.get_text(strip=True):
            return el.get_text(strip=True)[:200]
    return fallback


def _get_cover_image(book: epub.EpubBook) -> Optional[bytes]:
    # Try cover item
    for item in book.get_items():
        if item.get_name().lower() in ("cover.jpg", "cover.jpeg", "cover.png"):
            return item.get_content()
    # Try first image
    for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
        content = item.get_content()
        if content and len(content) > 1000:
            return content
    return None


async def parse_epub_task(book_id: str, epub_bytes: bytes) -> None:
    db = get_client()
    tmp_path = None
    try:
        # Write epub to temp file
        with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as f:
            f.write(epub_bytes)
            tmp_path = f.name

        book = epub.read_epub(tmp_path)

        # Extract metadata
        title = book.get_metadata("DC", "title")
        title = title[0][0] if title else "Không có tiêu đề"
        author_meta = book.get_metadata("DC", "creator")
        author = author_meta[0][0] if author_meta else None

        # Upload cover
        cover_url = None
        cover_bytes = _get_cover_image(book)
        if cover_bytes:
            cover_path = f"covers/{book_id}/cover.jpg"
            cover_url = await storage_service.upload_bytes(
                bucket="covers",
                path=cover_path,
                data=cover_bytes,
                content_type="image/jpeg",
            )

        # Parse chapters in spine (reading) order so chapter_index matches the
        # actual reading sequence, not the epub's internal manifest order.
        # Fall back to get_items() if the epub has no spine (malformed epubs).
        chapters_data = []
        seen_ids = set()
        idx = 0

        spine_ids = [iid for iid, _ in getattr(book, "spine", [])]
        if spine_ids:
            ordered_items = [
                book.get_item_with_id(iid)
                for iid in spine_ids
            ]
            ordered_items = [
                i for i in ordered_items
                if i is not None and i.get_type() == ebooklib.ITEM_DOCUMENT
            ]
        else:
            ordered_items = [
                i for i in book.get_items()
                if i.get_type() == ebooklib.ITEM_DOCUMENT
            ]

        for item in ordered_items:
            item_id = item.get_id()
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)

            html_content = item.get_content().decode("utf-8", errors="replace")
            soup = BeautifulSoup(html_content, "lxml")
            text = html_to_text(html_content)

            # Skip very short items (TOC, copyright pages, etc.)
            if len(text) < 100:
                continue

            chapter_title = _extract_chapter_title(
                soup, f"Chương {idx + 1}"
            )
            word_count = len(text.split())

            chapters_data.append({
                "id": str(uuid.uuid4()),
                "book_id": book_id,
                "chapter_index": idx,
                "title": chapter_title,
                "text_content": text,
                "word_count": word_count,
                "status": "pending",
            })
            idx += 1

        if not chapters_data:
            raise ValueError("No readable chapters found in EPUB")

        # Auto-split merged EPUB spine items by Vietnamese/English chapter headers
        chapters_data, _missing = auto_split_chapters(chapters_data)

        # Insert chapters in batches to avoid Supabase statement timeout on large books
        BATCH_SIZE = 100
        for i in range(0, len(chapters_data), BATCH_SIZE):
            db.table("chapters").insert(chapters_data[i:i + BATCH_SIZE]).execute()

        # Update book metadata
        update_data: dict = {
            "title": title,
            "author": author,
            "total_chapters": len(chapters_data),
            "status": "parsed",
        }
        if cover_url:
            update_data["cover_url"] = cover_url
        db.table("books").update(update_data).eq("id", book_id).execute()

        logger.info(f"Book {book_id}: parsed {len(chapters_data)} chapters")

        # Auto-enqueue only the first 3 chapters — the rest are prefetched on demand
        PREFETCH_AHEAD = 3
        for ch in chapters_data[:PREFETCH_AHEAD]:
            await task_queue.enqueue(book_id, ch["id"])

        # Mark book as converting
        db.table("books").update({"status": "converting"}).eq("id", book_id).execute()

    except Exception as e:
        logger.exception(f"Error parsing book {book_id}: {e}")
        db.table("books").update({
            "status": "error",
        }).eq("id", book_id).execute()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
