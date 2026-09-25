"""Shared chapter-text cleanup primitives.

Used by both the admin endpoint (POST /api/books/{id}/strip-string) and the
bulk CLI (scripts/strip_string_from_book.py) so a preview in the admin UI and
an apply run from a terminal can never disagree about what gets removed.
"""
import difflib
import re
import unicodedata

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
    #
    # The 首发 tag is only trusted at the END of a line, where a release tag
    # sits. Bare "thủ phát" is also where two ordinary words meet — "đối thủ /
    # phát ra" (the opponent launches), "liên thủ / phát động", "tranh thủ /
    # phát triển" — and because this rule deletes the WHOLE line, the unanchored
    # form deleted 11 prose paragraphs from one scraped xianxia book, one of
    # them a chapter's entire 9,000-character body.
    (
        "69shuba",
        r"(?:(?:sáu|lục|6)\s*[-–]?\s*(?:9|chín|cửu)|69)\s*(?:sách|thư|quyển|văn\s*học)"
        r"|trang\s*web\s*(?:sáu|lục|6)\s*(?:9|chín|cửu)"
        r"|thủ\s*phát[\s.!。)）\]】」”]*$",
        True,
    ),
    # Galaxy Play streaming promo injected between paragraphs by wikidich-family
    # mirrors: a two-line block ("Truyện chữ tặng bạn gói xem phim Galaxy Play
    # Mobile …" + "Nhận quà ngay!"). Validated against 870 occurrences across
    # 435 chapters of one scraped book — uniform wording, no MT variants.
    (
        "galaxyplay",
        r"tặng\s*bạn\s*gói\s*xem\s*phim|galaxy\s*play\s*mobile|^\s*nhận\s*quà\s*ngay\s*!?\s*$",
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
HEADING_LINE = re.compile(r"^\s*Chương\s+\d+\s*[:.]")

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
        text, hits, _ = apply_strip(text, pattern, whole_line, protect=HEADING_LINE)
        if hits:
            counts[label] = hits
    return text, counts


# ── Duplicated chapter headings ───────────────────────────────────────────────
# A scraped chapter document repeats its own title: in the heading the parser
# takes the chapter title FROM, and again in the body — often with the site's
# breadcrumb, category and book title wedged between the copies. The reader
# renders the title above the text, so every copy shows up twice over. One
# 243-chapter book opened every chapter with its own title three times.
#
# The last leading copy of the title is the end of that header block, so cut
# up to it. Guarded so this never eats prose: it looks only a few lines in, and
# gives up if the block holds a line long enough to be real text.
LEADING_HEADER_LINES = 10
LEADING_HEADER_MAX_LEN = 120


def _heading_key(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip().casefold()


def _titles_match(line_key: str, title_key: str) -> bool:
    """Same heading, allowing for a typo — scraped copies drift by a letter
    ("nằm" vs "nằn"). The digits must match exactly, so a neighbouring
    chapter's near-identical title can never count as this one's.
    """
    if line_key == title_key:
        return True
    if re.findall(r"\d+", line_key) != re.findall(r"\d+", title_key):
        return False
    if abs(len(line_key) - len(title_key)) > max(4, len(title_key) * 0.15):
        return False
    return difflib.SequenceMatcher(None, line_key, title_key).ratio() >= 0.92


def strip_leading_title(text: str, title: str) -> tuple[str, int]:
    """Drop the header block up to the last leading copy of `title`.

    Returns (new_text, lines_removed); (text, 0) when the text does not open
    with its own title, when the block looks like prose, or when removing it
    would empty the chapter.
    """
    key = _heading_key(title or "")
    if not key or not text.strip():
        return text, 0

    lines = text.split("\n")
    seen = 0
    cut = -1
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        seen += 1
        if seen > LEADING_HEADER_LINES:
            break
        if _titles_match(_heading_key(line), key):
            cut = index
    if cut < 0:
        return text, 0

    dropped = [line.strip() for line in lines[: cut + 1] if line.strip()]
    # A long line in the block is a paragraph, not a heading — leave it all.
    if any(len(line) > LEADING_HEADER_MAX_LEN and not _titles_match(_heading_key(line), key) for line in dropped):
        return text, 0

    rest = "\n".join(lines[cut + 1 :]).strip()
    if not rest:
        return text, 0
    return rest, len(dropped)


# ── Trailing site furniture ──────────────────────────────────────────────────
# Scraped chapters end with a stack of site lines: a dot separator, an
# "(end of chapter)" marker, a keyboard-navigation hint, an upload credit and
# the book title — each in several machine-translated wordings. They are read
# aloud by TTS and shown in the reader, so they have to go; the author's
# update notes in brackets go with them.
#
# Matched from the END backwards, stopping at the first line that is not site
# furniture, so nothing in the body of a chapter can be touched.
_TRAILING_RULES: tuple[re.Pattern[str], ...] = (
    # Dot/middot separators and stray punctuation-only lines.
    re.compile(r"^[.·•…\-–—~*\s]{1,}$"),
    # "(Kết thúc chương này)" / "(Chương này kết thúc.)" and similar.
    re.compile(r"^[(（]?\s*(?:kết thúc chương này|chương này kết thúc|hết chương)\s*[.!]?\s*[)）]?$", re.I),
    # "Lưu ý: Nhấn phím Enter để quay lại danh sách chương…" (many wordings).
    re.compile(r"^lưu ý.{0,20}[:：]?.*(?:enter|←|→).*$", re.I),
    # "Tất cả các chương và nội dung hình ảnh đều được cập nhật bởi…", also
    # seen as "cập nhật và đăng tải bởi…".
    re.compile(r"^tất cả .*(?:chương|nội dung).*(?:cập nhật|đăng tải).{0,30}bởi.*$", re.I),
    # The book title, printed again as a footer. Machine translation rewrites
    # it every which way — "tái sinh / sống lại / trở lại / trọng sinh" against
    # "công chức / công vụ / chức vụ công" in either order — so match the pair
    # of ideas in a line short enough to be a title, not a paragraph.
    re.compile(
        r"^(?=.{1,90}$)"  # title-length, not a paragraph
        r"(?=.*\bai\b)"  # the title is a question — "ai…?" — which keeps
                          # ordinary dialogue about rebirth or civil service
        r"(?=.*(?:tái sinh|sống lại|trở lại|trọng sinh))"
        r"(?=.*(?:công chức|công vụ|chức vụ))"
        r".+$",
        re.I,
    ),
    # The author's end-note to readers. Always fully bracketed and sitting
    # after the "······" separator, so a bracketed tail line is furniture, not
    # story — bounded in length so a long paragraph can never match.
    re.compile(r"^[(（].{0,400}[)）]\s*$", re.I | re.DOTALL),
)


def strip_trailing_boilerplate(text: str) -> tuple[str, int]:
    """Drop the site's end-of-chapter block. Returns (new_text, lines_removed)."""
    lines = text.split("\n")
    end = len(lines)
    removed = 0
    while end > 0:
        line = lines[end - 1].strip()
        if not line:
            end -= 1
            continue
        if any(rule.match(line) for rule in _TRAILING_RULES):
            end -= 1
            removed += 1
            continue
        # An author's note can wrap over several lines: the tail closes a
        # bracket it never opened. Walk back to the opening one and drop the
        # whole note, but only while it stays note-sized.
        if line.endswith((")", "）")):
            span = None
            for back in range(2, 7):
                if end - back < 0:
                    break
                candidate = lines[end - back].strip()
                if candidate.startswith(("(", "（")):
                    span = back
                    break
            if span and sum(len(l) for l in lines[end - span : end]) <= 400:
                end -= span
                removed += span
                continue
        break
    if not removed:
        return text, 0
    rest = "\n".join(lines[:end]).strip()
    # Never empty a chapter on the strength of these rules alone.
    if not rest:
        return text, 0
    return rest, removed
