import asyncio
import html
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
from app.services import storage_service, text_cleanup

logger = logging.getLogger(__name__)


def _install_tolerant_epub_reader() -> None:
    """Make ebooklib tolerate EPUBs whose OPF manifest declares files that are
    not actually present in the archive.

    ``EpubReader.read_file()`` eagerly reads every manifest item while loading
    the book and lets zipfile's ``KeyError`` propagate, which aborts the entire
    parse. Some EPUBs (notably exported Vietnamese web-novel bundles) list e.g.
    ``OEBPS/notes.html`` in the manifest without shipping the file — that single
    missing item used to fail the whole upload even though every real chapter is
    intact. We downgrade the missing-file case to empty content so the rest of
    the book still imports; an item with empty content yields no text and is
    skipped by the normal short-item filter downstream.

    Idempotent: safe to call multiple times.
    """
    if getattr(epub.EpubReader.read_file, "_tolerant_missing", False):
        return

    _orig_read_file = epub.EpubReader.read_file

    def _tolerant_read_file(self, name):
        try:
            return _orig_read_file(self, name)
        except KeyError:
            logger.warning(
                "EPUB manifest references missing file %r — substituting empty content",
                name,
            )
            return b""

    _tolerant_read_file._tolerant_missing = True
    epub.EpubReader.read_file = _tolerant_read_file


_install_tolerant_epub_reader()


_CHAPTER_HEADER_RE = re.compile(
    r'^(?:\d+\.\s*)?'          # optional leading "3. " numbering
    r'(chương|chapter)'        # the keyword
    r'\s+\d+',                 # followed by a chapter number
    re.IGNORECASE
)


# A real chapter in these books runs to hundreds of words. Anything shorter is
# a table-of-contents line, a glossary entry, an author note or a separator that
# merely starts with "Chương N" — _CHAPTER_HEADER_RE matches those exactly like
# a real heading, so without a floor a 500-line contents page becomes 500
# chapters.
MIN_CHAPTER_WORDS = 100


def merge_short_chapters(
    chapters: list[dict], min_words: int = MIN_CHAPTER_WORDS
) -> tuple[list[dict], int]:
    """Fold chapters shorter than `min_words` into the one before them.

    Merged rather than dropped on purpose: a short entry is usually junk, but
    silently losing real text during ingest is unrecoverable without a
    re-upload, so the text rides along inside the previous chapter where it
    stays visible (and removable with the strip-string tool). Short entries
    that appear before any qualifying chapter are held and prepended to the
    first one that qualifies — the same treatment split_text_by_headers gives
    to preamble.

    Returns (chapters, merged_count) and renumbers chapter_index / word_count.
    """
    if not chapters:
        return chapters, 0

    kept: list[dict] = []
    pending: list[str] = []

    for ch in chapters:
        text = ch.get("text_content") or ""
        if len(text.split()) >= min_words:
            entry = dict(ch)
            if pending:
                entry["text_content"] = "\n".join(pending + [text]).strip()
                pending = []
            kept.append(entry)
        elif kept:
            prev = kept[-1]
            prev["text_content"] = (prev["text_content"] + "\n" + text).strip()
        else:
            pending.append(text)

    if not kept:
        # Nothing clears the bar — a genuinely tiny book, or a file that is
        # nothing but headings. Returning an empty list here would surface as
        # "No readable chapters found", so keep what we had.
        return chapters, 0

    for i, entry in enumerate(kept):
        entry["chapter_index"] = i
        entry["word_count"] = len(entry["text_content"].split())

    return kept, len(chapters) - len(kept)


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

    new_chapters, merged = merge_short_chapters(new_chapters)

    # Re-check after merging. If folding the short entries back together leaves
    # no more chapters than the EPUB already had, the extra "chapters" were a
    # contents/glossary page rather than real content the spine had merged —
    # keep the EPUB's own structure.
    if len(new_chapters) <= len(chapters_data):
        return chapters_data, []

    logger.info(
        f"Auto-split: {len(chapters_data)} EPUB items → {len(new_chapters)} chapters"
        + (f", {merged} short entries merged (<{MIN_CHAPTER_WORDS} words)" if merged else "")
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


def _friendly_parse_error(exc: Exception) -> str:
    """Map a parse exception to a short, admin-readable reason (Vietnamese) with
    the technical detail appended, capped at 1000 chars so it fits the
    books.error_message column. Surfaced in the admin UI so failures are
    diagnosable without trawling server logs."""
    detail = f"{type(exc).__name__}: {exc}"
    low = str(exc).lower()
    if isinstance(exc, ValueError) and "no readable chapters" in low:
        friendly = "Không tìm thấy chương nào có thể đọc — file có thể trống hoặc sai định dạng."
    elif "there is no item named" in low:
        friendly = "EPUB tham chiếu tới tệp không tồn tại trong gói."
    elif "badzipfile" in low or "not a zip" in low or "bad zip" in low:
        friendly = "File EPUB bị hỏng (không phải tệp nén hợp lệ)."
    elif isinstance(exc, (KeyError, IndexError)):
        friendly = "Cấu trúc EPUB không hợp lệ hoặc thiếu thành phần bắt buộc."
    elif isinstance(exc, UnicodeError):
        friendly = "Lỗi mã hoá ký tự khi đọc nội dung file."
    else:
        friendly = "Phân tích file thất bại."
    return f"{friendly} ({detail})"[:1000]


# Parse-time chapter-text uploads run at this concurrency. Capped at 8 because
# higher values overwhelm storage3's shared connection and Supabase starts
# closing streams (see storage_service.STORAGE_CONCURRENCY).
_UPLOAD_CONCURRENCY = 8

# Strong refs to background text-upload tasks so the event loop doesn't GC them
# mid-flight after parse_epub_task returns.
_deferred_text_tasks: set = set()


async def _upload_deferred_chapter_text(book_id: str, chapters: list[dict]) -> None:
    """Upload chapter text to Storage AFTER the chapter rows are inserted and the
    book has flipped to 'converting'. Each row already carries the deterministic
    text_storage_path ({book_id}/{chapter_id}.txt), so the book is fully browsable
    the moment it leaves 'parsing'; this just fills in the Storage objects off the
    parse critical path. A chapter whose upload fails is marked 'error' so it
    surfaces in the admin UI and can be re-triggered."""
    db = get_client()
    sem = asyncio.Semaphore(_UPLOAD_CONCURRENCY)

    async def _one(ch: dict) -> bool:
        async with sem:
            try:
                await storage_service.upload_chapter_text(
                    book_id, ch["id"], ch["text_content"]
                )
                return True
            except Exception as e:
                logger.exception(
                    f"Book {book_id} chapter {ch['id']} ({ch.get('title')!r}) "
                    f"deferred text upload failed; marking errored"
                )
                try:
                    db.table("chapters").update({
                        "status": "error",
                        "error_message": f"{type(e).__name__}: {e}"[:1000],
                    }).eq("id", ch["id"]).execute()
                except Exception:
                    logger.exception(
                        f"Book {book_id}: could not mark chapter {ch['id']} errored"
                    )
                return False

    results = await asyncio.gather(*(_one(ch) for ch in chapters))
    failed = sum(1 for ok in results if not ok)
    if failed:
        logger.warning(
            f"Book {book_id}: {failed}/{len(chapters)} deferred chapter-text "
            f"uploads failed"
        )
    else:
        logger.info(
            f"Book {book_id}: uploaded all {len(chapters)} deferred chapter texts"
        )


def extract_epub_contents(epub_bytes: bytes, book_id: str) -> dict:
    """Pure-CPU extraction: EPUB bytes → metadata + ordered chapter dicts.

    Shared by the initial parse (parse_epub_task) and the append-chapters
    update flow (books router). Touches no DB or Storage, so callers can run
    it via asyncio.to_thread and keep the event loop responsive while a big
    book parses.

    Returns {title, author, cover_bytes, chapters}; chapter entries carry
    {id, book_id, chapter_index, title, text_content, word_count, status}.
    Raises ValueError when no readable chapters are found.
    """
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

        cover_bytes = _get_cover_image(book)

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

        skipped_short = 0
        skipped_dupe = 0
        for item in ordered_items:
            item_id = item.get_id()
            if item_id in seen_ids:
                skipped_dupe += 1
                continue
            seen_ids.add(item_id)

            # ebooklib normally returns bytes from get_content(), but for some
            # EPUBs (notably EpubNav-derived items, or items whose content was
            # assigned as a str during parsing) it hands back a str directly.
            # Decode only when we got bytes.
            raw = item.get_content()
            html_content = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
            soup = BeautifulSoup(html_content, "lxml")
            text = html_to_text(html_content)

            # Skip very short items (TOC, copyright pages, etc.)
            if len(text) < 100:
                skipped_short += 1
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

        logger.info(
            f"Book {book_id}: spine yielded {len(chapters_data)} chapters "
            f"(skipped {skipped_short} short, {skipped_dupe} duplicate of "
            f"{len(ordered_items)} spine items)"
        )

        if not chapters_data:
            raise ValueError("No readable chapters found in EPUB")

        # Many Vietnamese web-novel EPUBs pack 10+ chapters into a single spine
        # item — each "Chương N" is a header inside the same HTML file rather
        # than its own item. Re-split by chapter headers; only replaces the
        # list when strictly more chapters are detected, so well-structured
        # EPUBs are unaffected.
        split_chapters, missing_titles = auto_split_chapters(chapters_data)
        if len(split_chapters) > len(chapters_data):
            logger.info(
                f"Book {book_id}: auto-split expanded {len(chapters_data)} → "
                f"{len(split_chapters)} chapters"
                + (f" ({len(missing_titles)} headers had no body)" if missing_titles else "")
            )
            chapters_data = split_chapters

        # Strip source-site watermarks before anything reaches Storage, so a
        # freshly uploaded book never carries the scraper's advertising into
        # the reader, the generated audio, or the EPUB export. Runs after the
        # auto-split so chapter headings are already assigned and protected.
        scrubbed = 0
        rule_totals: dict[str, int] = {}
        for ch in chapters_data:
            clean, counts = text_cleanup.scrub_watermarks(ch["text_content"])
            if not counts:
                continue
            ch["text_content"] = clean
            ch["word_count"] = len(clean.split())
            for label, n in counts.items():
                rule_totals[label] = rule_totals.get(label, 0) + n
                scrubbed += n
        if scrubbed:
            logger.info(
                f"Book {book_id}: scrubbed {scrubbed} watermark(s) across "
                f"{len(chapters_data)} chapters {rule_totals}"
            )

        # Covers the path where auto_split never fires (a well-structured EPUB
        # whose own spine items include a contents page or author note).
        chapters_data, merged_short = merge_short_chapters(chapters_data)
        if merged_short:
            logger.info(
                f"Book {book_id}: merged {merged_short} entries under "
                f"{MIN_CHAPTER_WORDS} words into the preceding chapter"
            )

        return {
            "title": title,
            "author": author,
            "cover_bytes": cover_bytes,
            "chapters": chapters_data,
        }
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def build_epub(
    title: str,
    author: Optional[str],
    chapters: list[dict],
    cover_bytes: Optional[bytes] = None,
    identifier: Optional[str] = None,
) -> bytes:
    """Assemble an EPUB from chapter dicts ({title, text_content}) in reading
    order and return its bytes — the inverse of extract_epub_contents. Used by
    the book EPUB export so the file reflects the CURRENT chapters (edits,
    appends, splits) instead of the stored original, which may be a PDF/TXT
    or already cleaned up.

    Pure CPU + temp-file zip assembly — call via asyncio.to_thread from async
    code.
    """
    book = epub.EpubBook()
    book.set_identifier(identifier or str(uuid.uuid4()))
    book.set_title(title or "Truyện")
    book.set_language("vi")
    if author:
        book.add_author(author)
    if cover_bytes:
        # The file extension drives the manifest media-type — detect by magic
        # bytes rather than trusting the (long gone) upload filename.
        cover_name = "cover.jpg"
        if cover_bytes.startswith(b"\x89PNG"):
            cover_name = "cover.png"
        elif cover_bytes[:4] == b"RIFF" and cover_bytes[8:12] == b"WEBP":
            cover_name = "cover.webp"
        book.set_cover(cover_name, cover_bytes)

    items: list[epub.EpubHtml] = []
    for i, ch in enumerate(chapters):
        ch_title = (ch.get("title") or "").strip() or f"Chương {i + 1}"
        text = ch.get("text_content") or ""
        paragraphs = [ln.strip() for ln in text.split("\n") if ln.strip()]
        if not paragraphs:
            paragraphs = ["(Chương này chưa có nội dung)"]
        item = epub.EpubHtml(
            uid=f"chap{i + 1:05d}",
            title=ch_title,
            file_name=f"chap_{i + 1:05d}.xhtml",
            lang="vi",
        )
        item.content = f"<h2>{html.escape(ch_title)}</h2>" + "".join(
            f"<p>{html.escape(p)}</p>" for p in paragraphs
        )
        book.add_item(item)
        items.append(item)

    book.toc = items
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav"] + items

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as f:
            tmp_path = f.name
        epub.write_epub(tmp_path, book)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


async def parse_epub_task(book_id: str, epub_bytes: bytes) -> None:
    db = get_client()
    try:
        # CPU-heavy (zip extraction + BS4 over every chapter) — run on a worker
        # thread so the event loop stays responsive while a big book parses.
        extracted = await asyncio.to_thread(
            extract_epub_contents, epub_bytes, book_id
        )
        title = extracted["title"]
        author = extracted["author"]
        chapters_data = extracted["chapters"]

        # Upload cover
        cover_url = None
        if extracted["cover_bytes"]:
            cover_path = f"covers/{book_id}/cover.jpg"
            cover_url = await storage_service.upload_bytes(
                bucket="covers",
                path=cover_path,
                data=extracted["cover_bytes"],
                content_type="image/jpeg",
            )

        # Chapter text is stored in Storage at the deterministic path
        # {book_id}/{chapter_id}.txt. Set that path on every row up front so the
        # rows can be inserted — and the book made browsable — WITHOUT waiting for
        # the per-chapter Storage uploads, which at thousands of chapters are the
        # dominant cost of the parse (~N/8 round-trips). Only the first few
        # chapters are uploaded synchronously (so the opening chapters are
        # instantly readable, no race with the background upload); the rest upload
        # in a background task after the book is marked ready.
        for ch in chapters_data:
            ch["text_storage_path"] = storage_service.chapter_text_path(
                book_id, ch["id"]
            )

        PREFETCH_AHEAD = 3
        prefetch = chapters_data[:PREFETCH_AHEAD]
        deferred = chapters_data[PREFETCH_AHEAD:]

        # Upload the first few chapters' text synchronously so the chapters a
        # reader opens first are instantly available (no race with the background
        # upload below). A failure here just marks that chapter errored.
        prefetch_ok = 0
        for ch in prefetch:
            try:
                await storage_service.upload_chapter_text(
                    book_id, ch["id"], ch["text_content"]
                )
                prefetch_ok += 1
            except Exception as e:
                logger.exception(
                    f"Book {book_id} chapter {ch['id']} ({ch.get('title')!r}) "
                    f"text upload failed; marking errored"
                )
                ch["status"] = "error"
                ch["error_message"] = f"{type(e).__name__}: {e}"[:1000]

        # If every prefetch upload failed, Storage is almost certainly down —
        # abort the parse rather than insert a book whose chapters can never be
        # filled in. (With no prefetch chapters at all, skip this guard.)
        if prefetch and prefetch_ok == 0:
            raise RuntimeError(
                "All initial chapter-text uploads to Storage failed — aborting parse"
            )

        # Insert chapter rows (without the in-memory text_content, which is not a
        # DB column) in batches to avoid Supabase statement timeouts on large books.
        BATCH_SIZE = 100
        insert_rows = [
            {k: v for k, v in ch.items() if k != "text_content"}
            for ch in chapters_data
        ]
        for i in range(0, len(insert_rows), BATCH_SIZE):
            db.table("chapters").insert(insert_rows[i:i + BATCH_SIZE]).execute()

        # Update book metadata
        update_data: dict = {
            "title": title,
            "author": author,
            "total_chapters": len(chapters_data),
            "status": "parsed",
            "error_message": None,  # clear any prior failure (e.g. after reparse)
        }
        if cover_url:
            update_data["cover_url"] = cover_url
        db.table("books").update(update_data).eq("id", book_id).execute()

        logger.info(f"Book {book_id}: parsed {len(chapters_data)} chapters")

        # No audio pre-generation: playback streams TTS on demand (web →
        # /api/tts/speak, Android → native device TTS), so a parsed book is
        # immediately usable. Mark it 'ready' straight away rather than
        # 'converting' (which used to mean "generating MP3s"). Chapters stay
        # 'pending' — the players read chapter text, not a stored-audio status.
        db.table("books").update({"status": "ready"}).eq("id", book_id).execute()

        # Upload the remaining chapters' text in the background. The rows already
        # point at the right Storage paths, so the book is fully browsable now;
        # this just fills in the objects, off the parse critical path, so the book
        # leaves 'parsing' in seconds instead of after thousands of uploads.
        if deferred:
            bg = asyncio.create_task(
                _upload_deferred_chapter_text(book_id, deferred)
            )
            _deferred_text_tasks.add(bg)
            bg.add_done_callback(_deferred_text_tasks.discard)

    except Exception as e:
        logger.exception(f"Error parsing book {book_id}: {e}")
        db.table("books").update({
            "status": "error",
            "error_message": _friendly_parse_error(e),
        }).eq("id", book_id).execute()
