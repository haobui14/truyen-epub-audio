"""TXT/PDF regressions, including the generated EPUB -> stored-chapter path."""

import asyncio
import io
import os
import shutil
import sys
import unicodedata
from pathlib import Path

import fitz
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import pdf_ingestion
from app.services.converter import pdf_to_epub, txt_to_epub
from app.services.epub_parser import extract_epub_contents
from app.services.text_ingestion import (
    CHARS_PER_CHAPTER, WORDS_PER_CHAPTER, chapter_heading, decode_text,
    split_text_into_chapters,
)


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16", "utf-16-be", "utf-16-le", "utf-32", "utf-32-be"])
def test_unicode_decoding_preserves_vietnamese(encoding):
    source = "Chương 1: Khởi đầu\r\n\r\nMột câu chuyện tiếng Việt.\r\n"
    # UTF-32 BE without a BOM is not an advertised ambiguous legacy encoding.
    data = source.encode(encoding)
    if encoding == "utf-32-be":
        data = b"\x00\x00\xfe\xff" + data
    assert decode_text(data) == source.replace("\r\n", "\n").strip()


def test_windows_vietnamese_tone_marks_compose_correctly():
    source = "Chương 1: Bă\u0301t đâ\u0300u\nMô\u0323t nga\u0300y trong rư\u0300ng."
    assert decode_text(source.encode("cp1258")) == unicodedata.normalize("NFC", source)


def test_western_legacy_punctuation_is_not_mojibake():
    source = 'Chapter 1: Café\n“A naïve traveller”, she said. ' * 20
    assert decode_text(source.encode("cp1252")) == source.strip()


def test_chinese_legacy_encoding():
    source = "第十二章 新旅程\n这是一个新的故事，主人公走进森林。" * 20
    assert decode_text(source.encode("gb18030")) == source


@pytest.mark.parametrize("data", [b"", b" \r\n\t", b"PK\x03\x04\x00binary", b"\xff\xfe\x01", "bad\ufffdtext".encode()])
def test_bad_txt_fails_actionably(data):
    with pytest.raises(ValueError, match="TXT"):
        decode_text(data)


@pytest.mark.parametrize("heading", ["Chương 1001: Tiếp tục", "CHUONG 2", "Chapter XIV", "## Chương 3", "**Chương 4**", "3. Chương 5", "第十二章 新旅程"])
def test_heading_variants(heading):
    assert chapter_heading(heading)


@pytest.mark.parametrize("line", ["he mentions Chapter 1", "Chương 2 ........ 45", "Chapter 3 … 99", "Chapter IVory", "Chapter 2nd thoughts"])
def test_prose_and_toc_leaders_are_not_headings(line):
    assert chapter_heading(line) is None


def test_unheaded_book_chunks_and_keeps_short_tail():
    source = " ".join(["word"] * (WORDS_PER_CHAPTER * 2 + 1))
    chapters = split_text_into_chapters(source)
    assert len(chapters) == 3
    assert " ".join(ch["text"] for ch in chapters) == source
    assert chapters[-1]["text"] == "word"


def test_fallback_preserves_paragraphs_and_cjk_content():
    assert split_text_into_chapters("First paragraph.\n\nSecond paragraph.")[0]["text"] == "First paragraph.\n\nSecond paragraph."
    source = "故事" * CHARS_PER_CHAPTER
    chapters = split_text_into_chapters(source)
    assert len(chapters) == 2
    assert "".join(ch["text"] for ch in chapters) == source


def test_character_cap_does_not_cut_spaced_words_in_half():
    source = "longword " * (WORDS_PER_CHAPTER + 1)
    chapters = split_text_into_chapters(source)
    assert all(len(ch["text"]) <= CHARS_PER_CHAPTER for ch in chapters)
    assert " ".join(ch["text"] for ch in chapters).split() == source.split()


def test_preamble_short_chapters_and_final_note_survive():
    source = "Translator note\nChapter I\nTiny.\nChapter II\nThe end.\nChapter III"
    chapters = split_text_into_chapters(source)
    assert [ch["title"] for ch in chapters] == ["Chapter I", "Chapter II"]
    assert "Translator note" in chapters[0]["text"]
    assert "Tiny." in chapters[0]["text"]
    assert "The end." in chapters[1]["text"]
    assert "Chapter III" in chapters[1]["text"]


def test_contents_list_does_not_explode_into_empty_chapters():
    contents = "\n".join(f"Chương {i}" for i in range(1, 101))
    chapters = split_text_into_chapters(f"Mục lục\n{contents}\n\nChương 1\nNội dung thật.\nChương 2\nKết thúc.")
    assert len(chapters) == 2
    assert "Chương 100" in chapters[0]["text"]  # retained, not silently deleted


def test_txt_roundtrip_keeps_short_chapters_numeric_lines_and_accents():
    data = txt_to_epub("Chương 1: Một\nNội dung.\n42\nChương 2: Hai\nHết.".encode("utf-16"), "Sách")
    result = extract_epub_contents(data, "book-1", preserve_chapters=True)
    assert result["title"] == "Sách"
    assert [ch["title"] for ch in result["chapters"]] == ["Chương 1: Một", "Chương 2: Hai"]
    assert "42" in result["chapters"][0]["text_content"]
    assert result["chapters"][1]["text_content"].endswith("Hết.")
    assert [ch["chapter_index"] for ch in result["chapters"]] == [0, 1]


def test_generated_epub_does_not_repair_toc_into_extra_chapters():
    source = "\n".join(f"Chương {i}" for i in range(1, 150)) + "\nChương 1\nBody one.\nChương 2\nBody two."
    result = extract_epub_contents(txt_to_epub(source.encode(), "TOC"), "book-1", preserve_chapters=True)
    assert len(result["chapters"]) == 2


def _pdf(*pages: str, scan_index: int | None = None) -> bytes:
    with fitz.open() as doc:
        for i, text in enumerate(pages):
            page = doc.new_page()
            if scan_index == i:
                with Image.new("RGB", (20, 30), "gray") as image:
                    stream = io.BytesIO()
                    image.save(stream, format="PNG")
                    page.insert_image(page.rect, stream=stream.getvalue(), keep_proportion=False)
            if text:
                page.insert_text((72, 100), text, fontsize=11)
        return doc.tobytes()


def test_real_pdf_roundtrip_with_short_chapters_and_blank_page(monkeypatch):
    monkeypatch.setattr(pdf_ingestion, "_ocr_languages", lambda: pytest.fail("Text PDF must not need OCR"))
    source = _pdf("Chapter 1\nFirst paragraph.", "", "Chapter 2\nA short ending.")
    result = extract_epub_contents(pdf_to_epub(source, "PDF book"), "book-1", preserve_chapters=True)
    assert [ch["title"] for ch in result["chapters"]] == ["Chapter 1", "Chapter 2"]
    assert "A short ending." in result["chapters"][1]["text_content"]


def test_mixed_pdf_runs_ocr_only_on_scanned_page(monkeypatch):
    called = []
    monkeypatch.setattr(pdf_ingestion, "_ocr_languages", lambda: "vie+eng")
    def ocr(page, languages):
        called.append((page.number, languages))
        return "Chapter 2\nRecovered scan content."
    monkeypatch.setattr(pdf_ingestion, "_ocr_page", ocr)
    source = _pdf("Chapter 1\n" + "Digital content.\n" * 20, "2", "Chapter 3\nLast page.", scan_index=1)
    result = extract_epub_contents(pdf_to_epub(source, "Mixed"), "book-1", preserve_chapters=True)
    assert called == [(1, "vie+eng")]
    assert [ch["title"] for ch in result["chapters"]] == ["Chapter 1", "Chapter 2", "Chapter 3"]
    assert "Recovered scan content." in result["chapters"][1]["text_content"]


def test_pdf_removes_repeated_margins_but_keeps_body_repetition():
    with fitz.open() as doc:
        for i in range(3):
            page = doc.new_page()
            page.insert_text((72, 30), "Running book title")
            page.insert_text((72, 100), f"Chapter {i + 1}\nRepeated dialogue.\nA new adven-\nture begins.")
            page.insert_text((72, 820), f"Page {i + 1}")
        text = pdf_ingestion.extract_pdf_text(doc.tobytes())
    assert "Running book title" not in text
    assert "Page 1" not in text
    assert text.count("Repeated dialogue.") == 3
    assert "adventure begins." in text


def test_reflow_keeps_headings_and_dialogue():
    text = "Chapter 1\nA line wraps\nonto the next line.\n— Hello.\n— Goodbye."
    result = pdf_ingestion._reflow_block(text)
    assert result == "Chapter 1\n\nA line wraps onto the next line.\n\n— Hello.\n\n— Goodbye."


def test_alternating_pdf_headers_and_running_chapter_heading():
    pages = [
        [("Author name" if i % 2 else "Book title", "top"), (f"Unique body {i}.", None)]
        for i in range(8)
    ]
    text = pdf_ingestion._clean_pages(pages)
    assert "Author name" not in text and "Book title" not in text
    assert text.count("Unique body") == 8
    pages = [[("Chapter 1", "top"), (f"Body {i}.", None)] for i in range(4)]
    assert pdf_ingestion._clean_pages(pages).count("Chapter 1") == 1


@pytest.mark.parametrize("data", [b"%PDF-corrupt", _pdf("")])
def test_invalid_or_empty_pdf_is_actionable(data):
    with pytest.raises(ValueError, match="PDF"):
        pdf_to_epub(data, "Bad PDF")


def test_password_protected_pdf_is_actionable():
    with fitz.open(stream=_pdf("Secret"), filetype="pdf") as doc:
        data = doc.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="reader")
    with pytest.raises(ValueError, match="mật khẩu"):
        pdf_to_epub(data, "Locked")


def test_missing_ocr_language_fails_instead_of_partial_import(monkeypatch):
    import pytesseract
    monkeypatch.setattr(pytesseract, "get_languages", lambda **_: ["eng"])
    with pytest.raises(ValueError, match="vie và eng"):
        pdf_to_epub(_pdf("Chapter 1\nNative text.", "", scan_index=1), "Mixed")


def test_ocr_timeout_reports_page_and_bounds_image_memory(monkeypatch):
    import pytesseract
    monkeypatch.setattr(pytesseract, "get_languages", lambda **_: ["vie", "eng"])
    def timeout(image, **kwargs):
        assert image.width * image.height <= pdf_ingestion.MAX_OCR_PIXELS + 10000
        assert max(image.size) <= pdf_ingestion.MAX_OCR_DIMENSION
        assert kwargs["timeout"] == pdf_ingestion.OCR_TIMEOUT_SECONDS
        raise RuntimeError("Tesseract process timeout")
    monkeypatch.setattr(pytesseract, "image_to_string", timeout)
    with fitz.open(stream=_pdf("", scan_index=0), filetype="pdf") as doc:
        doc[0].set_mediabox(fitz.Rect(0, 0, 10000, 10000))
        with pytest.raises(ValueError, match="trang 1"):
            pdf_ingestion._ocr_page(doc[0], "vie+eng")


def test_real_ocr_roundtrip():
    if not shutil.which("tesseract"):
        if os.environ.get("REQUIRE_INGESTION_OCR") == "1":
            pytest.fail("CI requires Tesseract with vie+eng language data")
        pytest.skip("Tesseract binary is not installed locally; required in ingestion CI")
    with fitz.open() as original, fitz.open() as scanned:
        page = original.new_page()
        page.insert_text((72, 110), "Chapter 2\nA journey through the forest.\nThe morning sun was bright.", fontsize=20)
        rendered = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        target = scanned.new_page()
        target.insert_image(target.rect, stream=rendered.tobytes("png"))
        data = pdf_to_epub(scanned.tobytes(), "OCR smoke")
    chapters = extract_epub_contents(data, "book-1", preserve_chapters=True)["chapters"]
    assert chapters[0]["title"] == "Chapter 2"
    assert "journey through the forest" in chapters[0]["text_content"]


def test_initial_upload_requests_preserved_boundaries(monkeypatch):
    from app.routers import upload
    seen = []
    monkeypatch.setattr(upload, "get_client", lambda: object())
    async def parse(book_id, data, **kwargs):
        seen.append(kwargs["preserve_chapters"])
        assert len(extract_epub_contents(data, book_id, **kwargs)["chapters"]) == 2
    monkeypatch.setattr(upload.epub_parser, "parse_epub_task", parse)
    asyncio.run(upload._convert_and_parse("book-1", b"Chapter 1\nTiny.\nChapter 2\nEnd.", ".txt", "Book"))
    assert seen == [True]
