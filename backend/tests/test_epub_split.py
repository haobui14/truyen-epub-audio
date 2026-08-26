"""Regression tests for the chapter split/merge logic.

These two functions have caused every historical ingest regression: contents
pages exploding into hundreds of one-line chapters, preamble text silently
dropped, short author notes lost. They are pure functions — keep them covered.

Run from backend/:  python -m pytest tests/ -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.epub_parser import (  # noqa: E402
    MIN_CHAPTER_WORDS,
    merge_short_chapters,
    split_text_by_headers,
)


def _words(n: int, tag: str = "từ") -> str:
    return " ".join(f"{tag}{i}" for i in range(n))


BODY = _words(150)  # comfortably above MIN_CHAPTER_WORDS


# ── split_text_by_headers ────────────────────────────────────────────────────

def test_split_basic_two_chapters():
    text = f"Chương 1: Mở đầu\n{BODY}\nChương 2: Tiếp theo\n{BODY}"
    parts = split_text_by_headers(text)
    assert [p["title"] for p in parts] == ["Chương 1: Mở đầu", "Chương 2: Tiếp theo"]
    assert all(p["has_body"] for p in parts)
    # The title line is kept inside text_content (readers see the heading).
    assert parts[0]["text_content"].startswith("Chương 1: Mở đầu")


def test_split_accepts_chapter_english_and_numbered_prefix():
    text = f"3. Chương 4 tựa đề\n{BODY}\nCHAPTER 5\n{BODY}"
    parts = split_text_by_headers(text)
    assert len(parts) == 2


def test_split_preamble_merges_into_first_chapter():
    text = f"Lời giới thiệu của dịch giả\nChương 1: A\n{BODY}"
    parts = split_text_by_headers(text)
    assert len(parts) == 1
    assert "Lời giới thiệu của dịch giả" in parts[0]["text_content"]
    assert parts[0]["has_body"] is True


def test_split_header_without_body_flagged():
    text = f"Chương 1: A\nChương 2: B\n{BODY}"
    parts = split_text_by_headers(text)
    assert parts[0]["has_body"] is False
    assert parts[1]["has_body"] is True


def test_split_plain_prose_line_mentioning_chapter_is_not_a_header():
    # _CHAPTER_HEADER_RE requires the line to START with the keyword+number.
    text = f"Chương 1: A\n{BODY}\nhắn nhớ lại chương 2 của cuốn sách\n{BODY}"
    parts = split_text_by_headers(text)
    assert len(parts) == 1


def test_split_no_headers_returns_empty():
    assert split_text_by_headers(_words(50)) == []


# ── merge_short_chapters ─────────────────────────────────────────────────────

def _ch(title: str, text: str) -> dict:
    return {"title": title, "text_content": text}


def test_merge_contents_page_folds_into_previous_chapter():
    # The historical bug: a contents page split into one entry per "Chương N"
    # line, each far under the word floor, became hundreds of chapters.
    toc_entries = [_ch(f"Chương {i}", f"Chương {i}") for i in range(2, 30)]
    chapters = [_ch("Chương 1: Thật", BODY)] + toc_entries
    kept, merged = merge_short_chapters(chapters)
    assert len(kept) == 1
    assert merged == len(toc_entries)
    # Nothing was silently dropped — the junk text rides along.
    assert "Chương 29" in kept[0]["text_content"]


def test_merge_short_leading_entries_prepend_to_first_real_chapter():
    chapters = [
        _ch("Chương 0: Giới thiệu", "vài dòng ngắn"),
        _ch("Chương 1: Thật", BODY),
    ]
    kept, merged = merge_short_chapters(chapters)
    assert len(kept) == 1 and merged == 1
    assert kept[0]["title"] == "Chương 1: Thật"
    assert "vài dòng ngắn" in kept[0]["text_content"]


def test_merge_renumbers_and_recounts():
    chapters = [
        _ch("Chương 1", BODY),
        _ch("ghi chú", "ngắn"),
        _ch("Chương 2", BODY),
    ]
    kept, merged = merge_short_chapters(chapters)
    assert merged == 1
    assert [c["chapter_index"] for c in kept] == [0, 1]
    assert all(c["word_count"] == len(c["text_content"].split()) for c in kept)


def test_merge_all_short_keeps_original_list():
    # A genuinely tiny book must not collapse to "no readable chapters".
    chapters = [_ch("Chương 1", "ngắn"), _ch("Chương 2", "cũng ngắn")]
    kept, merged = merge_short_chapters(chapters)
    assert kept == chapters and merged == 0


def test_merge_respects_word_floor_constant():
    exactly_at_floor = _words(MIN_CHAPTER_WORDS)
    kept, merged = merge_short_chapters([_ch("Chương 1", exactly_at_floor)])
    assert len(kept) == 1 and merged == 0
