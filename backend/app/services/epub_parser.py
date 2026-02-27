import asyncio
import os
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

        # Parse chapters from spine
        chapters_data = []
        seen_ids = set()
        idx = 0
        for item in book.get_items():
            if item.get_type() != ebooklib.ITEM_DOCUMENT:
                continue
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

        # Insert chapters into DB
        db.table("chapters").insert(chapters_data).execute()

        # Update book metadata
        db.table("books").update({
            "title": title,
            "author": author,
            "cover_url": cover_url,
            "total_chapters": len(chapters_data),
            "status": "parsed",
        }).eq("id", book_id).execute()

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
