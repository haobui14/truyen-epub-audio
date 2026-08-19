"""Shared chapter-text cleanup primitives.

Used by both the admin endpoint (POST /api/books/{id}/strip-string) and the
bulk CLI (scripts/strip_string_from_book.py) so a preview in the admin UI and
an apply run from a terminal can never disagree about what gets removed.
"""
import re

# Site watermarks are machine-translated per chapter, so the "same" promo line
# comes out different nearly every time (one 1058-chapter book carried 137
# variants of one line). That is why regex + whole-line removal exist: an exact
# string match cleans a few percent of the occurrences and looks like success.


def build_pattern(target: str, regex: bool) -> "re.Pattern[str]":
    """Compile `target`. Raises re.error when regex=True and it doesn't parse."""
    if not regex:
        return re.compile(re.escape(target))
    return re.compile(target, re.IGNORECASE)


def apply_strip(
    text: str,
    pattern: "re.Pattern[str]",
    whole_line: bool,
    protect: "re.Pattern[str] | None" = None,
) -> tuple[str, int, list[str]]:
    """Strip matches from chapter text, line by line.

    whole_line=True deletes the entire line a match appears on; otherwise only
    the matched fragment goes, and the line survives if any text is left on it.
    Either way, a line that ends up empty is removed along with the blank
    separators it would otherwise leave behind, so paragraph spacing stays put.

    `protect` marks lines that must never be touched however well they match —
    chapter headings, mainly, since a numbered heading can carry the same
    digits as a site name.

    Returns (new_text, occurrences, samples). occurrences == 0 means the text
    is unchanged and the caller should skip the Storage write entirely.
    """
    lines = text.split("\n")
    out: list[str] = []
    removed: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if (
            not stripped
            or (protect and protect.match(stripped))
            or not pattern.search(line)
        ):
            out.append(line)
            i += 1
            continue

        if whole_line:
            removed.append(stripped)
            new_line = ""
        else:
            removed.extend(
                m if isinstance(m, str) else str(m) for m in pattern.findall(line)
            )
            new_line = pattern.sub("", line)
        i += 1

        if new_line.strip():
            out.append(new_line)
            continue
        # The line is gone entirely. Chapters separate paragraphs with blank
        # lines; drop the ones this paragraph leaves behind so the text doesn't
        # grow a gap where the watermark used to be.
        eaten = 0
        while i < len(lines) and not lines[i].strip() and eaten < 2:
            i += 1
            eaten += 1

    if not removed:
        return text, 0, []
    # A footer watermark is the last line, so there are no following blanks to
    # swallow — it would leave the chapter ending in whitespace instead.
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out), len(removed), removed[:3]


# ── Source-site watermarks ────────────────────────────────────────────────────
# Ripped web-novel EPUBs carry the scraper site's advertising. Every rule here
# was written against text actually present in this library and validated over
# a 544-chapter sample spanning all 68 books — do not add speculative ones, a
# false positive silently deletes a reader's prose.
#
# whole_line=True  → the watermark occupies its own paragraph (the common case)
# whole_line=False → it is spliced into a real sentence, so the rule must match
#                    the injected phrase EXACTLY. Sentence-scoped patterns are
#                    deliberately avoided here: mid-sentence injections have
#                    genuine prose on both sides, and a rule that swallowed to
#                    the nearest full stop ate two real sentences in testing.

WATERMARK_RULES: tuple[tuple[str, str, bool], ...] = (
    ("dtv-ebook", r"dtv[\s\-_]*ebook", True),
    ("ebooktruyen", r"ebook\s*truyen\s*\.\s*(me|vn)|ebook\s*tạo\s*bởi\s*:", True),
    (
        "nguon-credit",
        r"^\s*(nguồn|chỉnh\s*sửa)\s*:\s*[\w.\-]+\.(com|vn|me|net|vip|pro|xyz|info|org)",
        True,
    ),
    ("bachngocsach", r"bachngocsach\.com", True),
    ("thichcode", r"truyen\.?\s*thichcode\.?\s*net", True),
    # Same site, letters split by punctuation to dodge exactly this kind of
    # filter ("d,o,wn-lo a d eb oo-k … t.h i ch.co de .n e t").
    (
        "thichcode-obfuscated",
        r"t[\s.,\-]*h[\s.,\-]*i[\s.,\-]*c[\s.,\-]*h[\s.,\-]*c[\s.,\-]*o[\s.,\-]*d[\s.,\-]*e",
        True,
    ),
    ("truyenclub", r"truyenclub\.com", True),
    ("truyenyy", r"truyenyy\.(vip|pro)", True),
    # 69shuba promo line. Machine-translated fresh in every chapter, so match
    # the site reference ("sáu 9 / lục cửu / 69 … sách a") or the 首发 tag
    # rather than any one phrasing — 137 variants in a single book.
    (
        "69shuba",
        r"(?:(?:sáu|lục|6)\s*[-–]?\s*(?:9|chín|cửu)|69)\s*(?:sách|thư|quyển|văn\s*học)"
        r"|trang\s*web\s*(?:sáu|lục|6)\s*(?:9|chín|cửu)"
        r"|thủ\s*phát",
        True,
    ),
    # Spliced into real sentences — phrase-exact, bounded middles.
    ("truyenfull-inline", r"\s*Đọc\s*Full\s*Tại\s*Truyenfull\.vn", False),
    (
        "truyenhoangdung-inline",
        r"\s*(?:bạn\s*đang\s*đọc\s*truyện\s*tại|truyện\s*được\s*dịch\s*và\s*update\s*tại)"
        r"\s*truyenhoangdung\.xyz|\s*truyenhoangdung\.xyz",
        False,
    ),
    (
        "tamlinh247-inline",
        r"\s*Hiện tại có rất nhiều website[^\n]{0,160}?Tamlinh247\.com[^\n]{0,160}?!+"
        r"|\s*Hãy quay lại ủng hộ [Ww]ebsite Tamlinh247\.com[^\n]{0,160}?nhé\.",
        False,
    ),
)

# Never delete a chapter heading, whatever it matches: "Chương 69: …" carries
# the 69shuba site number, and headings are structure, not content.
_HEADING = re.compile(r"^\s*Chương\s+\d+\s*[:.]")

_COMPILED_RULES = tuple(
    (label, re.compile(pattern, re.IGNORECASE | re.MULTILINE), whole_line)
    for label, pattern, whole_line in WATERMARK_RULES
)


def scrub_watermarks(text: str) -> tuple[str, dict[str, int]]:
    """Remove every known source-site watermark from one chapter's text.

    Returns (clean_text, {rule_label: occurrences}). An empty dict means the
    text was left byte-identical.
    """
    counts: dict[str, int] = {}
    for label, pattern, whole_line in _COMPILED_RULES:
        text, hits, _ = apply_strip(text, pattern, whole_line, protect=_HEADING)
        if hits:
            counts[label] = hits
    return text, counts
