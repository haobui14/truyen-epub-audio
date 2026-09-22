"""
Convert TXT, PDF, and PRC/MOBI files to EPUB, then feed into the existing
EPUB parser.

Strategy:
  TXT      → split into chapters by heading detection or ~5000-word chunks → EPUB
  PDF      → extract text (PyMuPDF for text PDFs, pytesseract OCR for image PDFs)
             → same chapter splitting → EPUB
  PRC/MOBI → extract via mobi library (KindleUnpack) → EPUB or HTML → EPUB
"""

import logging
import os
import shutil
import tempfile
import uuid
from typing import Optional

import ebooklib
from ebooklib import epub

from app.services.pdf_ingestion import extract_pdf_text
from app.services.text_ingestion import (
    decode_text,
    split_text_into_chapters as _split_text_into_chapters,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# EPUB assembly
# ---------------------------------------------------------------------------

def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _text_to_html_body(text: str) -> str:
    paras = []
    for para in text.split("\n"):
        para = para.strip()
        if para:
            paras.append(f"<p>{_escape_html(para)}</p>")
    return "\n".join(paras)


def _chapters_to_epub(
    chapters: list[dict],
    title: str,
    author: Optional[str] = None,
) -> bytes:
    """Assemble an EPUB from a list of {'title', 'text'} dicts."""
    book = epub.EpubBook()
    book.set_identifier(str(uuid.uuid4()))
    book.set_title(title)
    book.set_language("vi")
    if author:
        book.add_author(author)

    epub_chapters: list[epub.EpubHtml] = []
    toc = []
    spine: list = ["nav"]

    for i, ch in enumerate(chapters):
        ch_title = _escape_html(ch["title"])
        html = (
            "<?xml version='1.0' encoding='utf-8'?>\n"
            "<!DOCTYPE html>\n"
            '<html xmlns="http://www.w3.org/1999/xhtml">\n'
            f"<head><title>{ch_title}</title></head>\n"
            "<body>\n"
            f"<h1>{ch_title}</h1>\n"
            f"{_text_to_html_body(ch['text'])}\n"
            "</body>\n</html>"
        )
        item = epub.EpubHtml(
            title=ch["title"],
            file_name=f"chapter_{i + 1:04d}.xhtml",
            lang="vi",
        )
        # MUST be bytes. ebooklib >=0.18 silently drops str content — the chapter
        # files are still written into the archive, but at zero length, so the
        # EPUB looks structurally valid and then parses to "no readable chapters".
        item.set_content(html.encode("utf-8"))
        book.add_item(item)
        epub_chapters.append(item)
        toc.append(epub.Link(f"chapter_{i + 1:04d}.xhtml", ch["title"], f"chap{i + 1}"))
        spine.append(item)

    book.toc = toc
    book.spine = spine
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())

    # ebooklib requires a file path (BytesIO is not supported)
    tmp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as f:
            tmp_path = f.name
        epub.write_epub(tmp_path, book, {"epub3_pages": False})
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Public converters
# ---------------------------------------------------------------------------

def txt_to_epub(txt_bytes: bytes, title: str) -> bytes:
    """Convert a plain-text file to EPUB bytes."""
    text = decode_text(txt_bytes)

    chapters = _split_text_into_chapters(text)
    if not chapters:
        raise ValueError("No readable content found in TXT file")

    logger.info(f"TXT→EPUB: '{title}' → {len(chapters)} chapters")
    return _chapters_to_epub(chapters, title)


def pdf_to_epub(pdf_bytes: bytes, title: str) -> bytes:
    """Convert text, scanned or mixed PDFs using page-wise extraction/OCR."""
    chapters = _split_text_into_chapters(extract_pdf_text(pdf_bytes))
    logger.info("PDF→EPUB: '%s' → %d chapters", title, len(chapters))
    return _chapters_to_epub(chapters, title)


def _read_html_to_text(filepath: str) -> str:
    """Read an HTML file and return cleaned plain text.

    Tries UTF-8 first, falls back to latin-1 for older PRC files that use
    windows-1252 or similar single-byte encodings.
    """
    from bs4 import BeautifulSoup

    for encoding in ("utf-8", "latin-1"):
        try:
            with open(filepath, "r", encoding=encoding, errors="replace") as f:
                html = f.read()
            break
        except UnicodeDecodeError:
            continue
    else:
        with open(filepath, "rb") as f:
            html = f.read().decode("utf-8", errors="replace")

    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "img", "figure", "nav"]):
        tag.decompose()
    return soup.get_text(separator="\n")


def prc_to_epub(prc_bytes: bytes, title: str) -> bytes:
    """
    Convert a PRC/MOBI file to EPUB bytes.

    Uses the ``mobi`` library (KindleUnpack) to extract the file.  Handles
    three possible extraction outputs:

    - **EPUB** (KF8/mobi8) — validated and returned directly; falls back to
      HTML re-parse if the EPUB is corrupt.
    - **HTML** (mobi7)     — text extracted, split into chapters, assembled
      into a fresh EPUB.
    - **PDF** (Print Replica) — routed through the existing ``pdf_to_epub``
      converter.

    Edge cases covered:
    - DRM-encrypted books → clear error message
    - Invalid/corrupt PRC files → clear error message
    - Empty content after extraction
    - Encoding variations (UTF-8 / latin-1 / windows-1252)
    """
    import mobi
    from mobi.kindleunpack import unpackException

    tmp_path: Optional[str] = None
    extract_dir: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".prc", delete=False) as f:
            f.write(prc_bytes)
            tmp_path = f.name

        # --- Extract --------------------------------------------------------
        try:
            extract_dir, filepath = mobi.extract(tmp_path)
        except unpackException as e:
            msg = str(e)
            if "encrypt" in msg.lower():
                raise ValueError(
                    "File PRC/MOBI được bảo vệ bằng DRM, không thể đọc"
                ) from e
            if "invalid file format" in msg.lower():
                raise ValueError(
                    "File không phải định dạng PRC/MOBI hợp lệ"
                ) from e
            raise ValueError(f"Không thể giải nén file PRC/MOBI: {msg}") from e
        except Exception as e:
            raise ValueError(
                f"Không thể giải nén file PRC/MOBI: {e}"
            ) from e

        filepath_lower = filepath.lower()

        # --- Case 1: KindleUnpack produced a PDF (Print Replica) ------------
        if filepath_lower.endswith(".pdf"):
            logger.info(f"PRC→EPUB: '{title}' — Print Replica PDF detected, "
                        "routing through PDF converter")
            with open(filepath, "rb") as f:
                pdf_bytes = f.read()
            return pdf_to_epub(pdf_bytes, title)

        # --- Case 2: KindleUnpack produced an EPUB (KF8 / mobi8) -----------
        if filepath_lower.endswith(".epub"):
            with open(filepath, "rb") as f:
                epub_bytes = f.read()

            # Validate the EPUB is usable — some mobi8 EPUBs are malformed
            tmp_epub: Optional[str] = None
            try:
                from ebooklib import epub as epublib
                with tempfile.NamedTemporaryFile(
                    suffix=".epub", delete=False
                ) as ef:
                    ef.write(epub_bytes)
                    tmp_epub = ef.name
                book = epublib.read_epub(tmp_epub)
                has_content = any(
                    item.get_type() == ebooklib.ITEM_DOCUMENT
                    for item in book.get_items()
                )
                if has_content:
                    logger.info(
                        f"PRC→EPUB: '{title}' — extracted KF8 EPUB directly"
                    )
                    return epub_bytes
                logger.warning(
                    f"PRC→EPUB: '{title}' — KF8 EPUB has no document items, "
                    "falling back to HTML"
                )
            except Exception as epub_err:
                logger.warning(
                    f"PRC→EPUB: '{title}' — KF8 EPUB is malformed "
                    f"({epub_err}), falling back to HTML"
                )
            finally:
                if tmp_epub and os.path.exists(tmp_epub):
                    os.unlink(tmp_epub)

            # Fall through to HTML extraction from mobi7
            mobi7_html = os.path.join(
                extract_dir, "mobi7", "book.html"
            )
            if not os.path.isfile(mobi7_html):
                raise ValueError(
                    "KF8 EPUB is corrupt and no mobi7 HTML fallback available"
                )
            filepath = mobi7_html

        # --- Case 3: HTML (mobi7) — parse text and build EPUB --------------
        full_text = _read_html_to_text(filepath)

        if len(full_text.strip()) < 50:
            raise ValueError("No readable content found in PRC/MOBI file")

        chapters = _split_text_into_chapters(full_text)
        if not chapters:
            raise ValueError("No readable content found in PRC/MOBI file")

        logger.info(
            f"PRC→EPUB: '{title}' → {len(chapters)} chapters (from HTML)"
        )
        return _chapters_to_epub(chapters, title)

    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        if extract_dir and os.path.isdir(extract_dir):
            shutil.rmtree(extract_dir, ignore_errors=True)
