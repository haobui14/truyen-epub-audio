"""Regression tests for watermark stripping.

Every rule in WATERMARK_RULES was written against text actually present in the
library; these tests pin the semantics that made the cleanup safe — whole-line
removal, blank-line swallowing, heading protection — so a future rule tweak
can't silently start eating prose.

Run from backend/:  python -m pytest tests/ -q
"""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.text_cleanup import (  # noqa: E402
    apply_strip,
    build_pattern,
    scrub_watermarks,
)


# ── build_pattern ────────────────────────────────────────────────────────────

def test_literal_mode_escapes_regex_metacharacters():
    p = build_pattern("truyen.club (hot)", regex=False)
    assert p.search("đọc tại truyen.club (hot) nhé")
    assert not p.search("truyenXclub hot")  # '.' must not act as a wildcard


def test_regex_mode_invalid_pattern_raises():
    with pytest.raises(re.error):
        build_pattern("[unclosed", regex=True)


# ── apply_strip ──────────────────────────────────────────────────────────────

def test_whole_line_removes_line_and_following_blank():
    text = "đoạn một\n\nquảng cáo dtv-ebook ở đây\n\nđoạn hai"
    new, hits, samples = apply_strip(text, build_pattern("dtv-ebook", False), True)
    assert hits == 1
    assert new == "đoạn một\n\nđoạn hai"  # paragraph spacing preserved, no double gap
    assert samples == ["quảng cáo dtv-ebook ở đây"]


def test_fragment_mode_keeps_rest_of_line():
    text = "câu văn thật Đọc Full Tại Truyenfull.vn còn tiếp"
    pattern = build_pattern(r"\s*Đọc\s*Full\s*Tại\s*Truyenfull\.vn", True)
    new, hits, _ = apply_strip(text, pattern, whole_line=False)
    assert hits == 1
    assert new == "câu văn thật còn tiếp"


def test_no_match_returns_text_unchanged_and_zero():
    text = "văn bản sạch\n\nkhông có gì để xóa"
    new, hits, _ = apply_strip(text, build_pattern("watermark", False), True)
    assert hits == 0 and new == text  # 0 tells callers to skip the Storage write


def test_protect_shields_matching_headings():
    heading_guard = re.compile(r"^\s*Chương\s+\d+\s*[:.]")
    text = "Chương 69: Đại chiến\nnội dung 69 sách quảng cáo"
    pattern = build_pattern(r"69\s*sách", True)
    new, hits, _ = apply_strip(text, pattern, True, protect=heading_guard)
    assert "Chương 69: Đại chiến" in new  # heading survives despite matching
    assert hits == 1  # the ad line still goes


def test_trailing_footer_removal_leaves_no_trailing_blank():
    text = "nội dung chương\n\nnguồn: bachngocsach.com"
    new, hits, _ = apply_strip(text, build_pattern("bachngocsach.com", False), True)
    assert hits == 1
    assert new == "nội dung chương"


# ── scrub_watermarks (the shipped rules) ─────────────────────────────────────

def test_scrub_known_watermarks_and_counts():
    text = (
        "Chương 12: Bắt đầu\n"
        "đoạn văn thật thứ nhất\n\n"
        "Nguồn: metruyenchu.com\n\n"
        "truyện được dịch và update tại truyenhoangdung.xyz\n"
        "đoạn văn thật thứ hai"
    )
    clean, counts = scrub_watermarks(text)
    assert "metruyenchu" not in clean
    assert "truyenhoangdung" not in clean
    assert "đoạn văn thật thứ nhất" in clean
    assert "đoạn văn thật thứ hai" in clean
    assert "Chương 12: Bắt đầu" in clean
    assert counts  # at least one rule reported hits


def test_scrub_obfuscated_thichcode_variant():
    clean, counts = scrub_watermarks("văn thật\nt.h i ch.co de .n e t tải sách\nvăn thật hai")
    assert "thichcode-obfuscated" in counts
    assert clean == "văn thật\nvăn thật hai"


def test_scrub_clean_text_returns_empty_counts():
    text = "Chương 1: Sạch\nvăn bản hoàn toàn bình thường"
    clean, counts = scrub_watermarks(text)
    assert clean == text and counts == {}
