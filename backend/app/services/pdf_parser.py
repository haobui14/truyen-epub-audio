import asyncio
import logging
import os
import re
import tempfile
import uuid
from typing import Optional

from app.database import get_client
from app.utils.text_cleaner import clean_text
from app.services import storage_service, task_queue

logger = logging.getLogger(__name__)

PAGES_PER_CHAPTER = 20
MIN_CHARS_PER_PAGE = 80  # below this avg → treat as image PDF


def _extract_text_pymupdf(pdf_path: str) -> list[str]:
    import fitz  # PyMuPDF
    doc = fitz.open(pdf_path)
    pages = [page.get_text() for page in doc]
    doc.close()
    return pages


def _extract_text_ocr(pdf_path: str) -> list[str]:
    from pdf2image import convert_from_path
    import pytesseract

    images = convert_from_path(pdf_path, dpi=200)
    pages = []
    for img in images:
        text = pytesseract.image_to_string(img, lang="vie+eng")
        pages.append(text)
    return pages


def _is_chapter_heading(line: str) -> bool:
    line = line.strip()
    if not line or len(line) > 120:
        return False
    patterns = [
        r"^chương\s+\d+",
        r"^chapter\s+\d+",
        r"^phần\s+\d+",
        r"^part\s+\d+",
        r"^quyển\s+\d+",
    ]
    lower = line.lower()
    return any(re.match(p, lower) for p in patterns)


def _split_into_chapters(pages: list[str]) -> list[dict]:
    # Find pages that start with a chapter heading
    heading_positions: list[tuple[int, str]] = []
    for i, page_text in enumerate(pages):
        lines = [l.strip() for l in page_text.split("\n") if l.strip()]
        if lines and _is_chapter_heading(lines[0]):
            heading_positions.append((i, lines[0][:200]))

    chapters = []
    if heading_positions:
        for j, (start_idx, title) in enumerate(heading_positions):
            end_idx = heading_positions[j + 1][0] if j + 1 < len(heading_positions) else len(pages)
            text = clean_text("\n\n".join(pages[start_idx:end_idx]))
            if len(text) >= 100:
                chapters.append({"title": title, "text": text, "idx": len(chapters)})
    else:
        # No headings detected — group by PAGES_PER_CHAPTER
        for i in range(0, len(pages), PAGES_PER_CHAPTER):
            chunk = pages[i : i + PAGES_PER_CHAPTER]
            text = clean_text("\n\n".join(chunk))
            if len(text) >= 100:
                chapters.append({
                    "title": f"Chương {len(chapters) + 1}",
                    "text": text,
                    "idx": len(chapters),
                })

    return chapters


def _get_pdf_title(pdf_path: str, fallback: str) -> str:
    try:
        import fitz
        doc = fitz.open(pdf_path)
        meta = doc.metadata
        doc.close()
        return (meta.get("title") or "").strip() or fallback
    except Exception:
        return fallback


async def parse_pdf_task(book_id: str, pdf_bytes: bytes, filename: str) -> None:
    db = get_client()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            tmp_path = f.name

        # Try text extraction first
        pages = _extract_text_pymupdf(tmp_path)
        total_chars = sum(len(p) for p in pages)
        avg_chars = total_chars / max(len(pages), 1)

        if avg_chars < MIN_CHARS_PER_PAGE:
            logger.info(f"Book {book_id}: image PDF detected (avg {avg_chars:.0f} chars/page), using OCR")
            pages = _extract_text_ocr(tmp_path)
        else:
            logger.info(f"Book {book_id}: text PDF (avg {avg_chars:.0f} chars/page)")

        chapters_raw = _split_into_chapters(pages)
        if not chapters_raw:
            raise ValueError("No readable content found in PDF")

        title = _get_pdf_title(tmp_path, fallback=filename.replace(".pdf", ""))

        chapters_data = [
            {
                "id": str(uuid.uuid4()),
                "book_id": book_id,
                "chapter_index": ch["idx"],
                "title": ch["title"],
                "text_content": ch["text"],
                "word_count": len(ch["text"].split()),
                "status": "pending",
            }
            for ch in chapters_raw
        ]

        db.table("chapters").insert(chapters_data).execute()
        db.table("books").update({
            "title": title,
            "total_chapters": len(chapters_data),
            "status": "parsed",
        }).eq("id", book_id).execute()

        logger.info(f"Book {book_id}: parsed {len(chapters_data)} chapters from PDF")

        PREFETCH_AHEAD = 3
        for ch in chapters_data[:PREFETCH_AHEAD]:
            await task_queue.enqueue(book_id, ch["id"])

        db.table("books").update({"status": "converting"}).eq("id", book_id).execute()

    except Exception as e:
        logger.exception(f"Error parsing PDF book {book_id}: {e}")
        db.table("books").update({"status": "error"}).eq("id", book_id).execute()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
