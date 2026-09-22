"""Strict decoding and conservative chapter splitting for document imports."""

import codecs
import re
import unicodedata
from collections.abc import Iterator

from charset_normalizer import from_bytes

WORDS_PER_CHAPTER = 5000
CHARS_PER_CHAPTER = 30000  # Also bounds text in languages without word spaces.

_HEADING_RE = re.compile(
    r"^(?:(?:\d+\.\s*)?(?:chương|chuong|chapter|phần|phan|part|quyển|quyen|volume|bài|bai)"
    r"\s+(?:\d+|[ivxlcdm]+)(?=$|[\s:：.\-–—])"
    r"|第[\d零〇一二三四五六七八九十百千万两]+[章节卷回])",
    re.IGNORECASE,
)
_TOC_LEADER_RE = re.compile(r"(?:\.{2,}|…+|·{2,})\s*\d+\s*$")


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n\n")
    text = text.replace("\u2028", "\n").replace("\u2029", "\n\n")
    text = text.replace("\ufeff", "").replace("\u200b", "").replace("\u00ad", "")
    text = text.replace("\xa0", " ")
    return "\n".join(line.strip() for line in text.splitlines()).strip()


def _validate_decoded_text(text: str) -> str:
    # Reject binary/control data instead of silently importing replacement glyphs.
    if any(unicodedata.category(c) == "Cc" and c not in "\n\r\t\f" for c in text):
        raise ValueError("File TXT chứa dữ liệu nhị phân hoặc mã hóa không hỗ trợ. Hãy lưu lại dưới dạng UTF-8.")
    text = normalize_text(text)
    if not text or not any(c.isalnum() for c in text):
        raise ValueError("File TXT không có nội dung có thể đọc.")
    if "\ufffd" in text:
        raise ValueError("File TXT có ký tự bị lỗi. Hãy kiểm tra bản gốc và lưu lại dưới dạng UTF-8.")
    return text


def decode_text(data: bytes) -> str:
    """Prefer explicit Unicode; recognize legacy encodings without lossy fallback."""
    for bom, encoding in (
        (codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"),
        (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16"),
        (codecs.BOM_UTF8, "utf-8-sig"),
    ):
        if data.startswith(bom):
            try:
                return _validate_decoded_text(data.decode(encoding))
            except UnicodeError as exc:
                raise ValueError("File TXT bị cắt hoặc sai mã hóa Unicode. Hãy lưu lại dưới dạng UTF-8.") from exc

    # Windows exports may omit the UTF-16 BOM. Detect the zero-byte lane first,
    # since ASCII-looking UTF-16 otherwise 'decodes' as UTF-8 containing NULs.
    if len(data) >= 4 and len(data) % 2 == 0:
        for lane, encoding in ((1, "utf-16-le"), (0, "utf-16-be")):
            sample = data[:8192]
            if sample[lane::2].count(0) / (len(sample) / 2) > 0.4 and sample[1-lane::2].count(0) == 0:
                try:
                    return _validate_decoded_text(data.decode(encoding))
                except UnicodeError as exc:
                    raise ValueError("File TXT sai mã hóa UTF-16. Hãy lưu lại dưới dạng UTF-8.") from exc
    try:
        return _validate_decoded_text(data.decode("utf-8"))
    except UnicodeDecodeError:
        pass

    # CP1258 stores Vietnamese tone marks separately; generic detectors often
    # mistake these files for Western European encodings. Require real vowel +
    # tone pairs, then NFC composes the accents for heading detection and TTS.
    try:
        vietnamese = data.decode("cp1258")
        if re.search(r"[aăâeêioôơuưyAĂÂEÊIOÔƠUƯY][\u0300\u0301\u0303\u0309\u0323]", vietnamese):
            return _validate_decoded_text(vietnamese)
    except UnicodeDecodeError:
        pass
    match = from_bytes(data, cp_isolation=["cp1252", "cp1258", "gb18030", "big5"], enable_fallback=False).best()
    if match is None:
        raise ValueError("Không xác định được mã hóa TXT. Hãy lưu file dưới dạng UTF-8 rồi tải lại.")
    return _validate_decoded_text(str(match))


def chapter_heading(line: str) -> str | None:
    candidate = line.strip()
    candidate = re.sub(r"^#{1,6}\s+", "", candidate)
    if candidate.startswith("**") and candidate.endswith("**"):
        candidate = candidate[2:-2].strip()
    if not candidate or len(candidate) > 120 or _TOC_LEADER_RE.search(candidate):
        return None
    return candidate if _HEADING_RE.match(candidate) else None


def _paragraph_parts(paragraph: str) -> Iterator[str]:
    """Bound both words and characters, preferring word boundaries when present."""
    start = end = count = 0
    for word in re.finditer(r"\S+", paragraph):
        if count and (count >= WORDS_PER_CHAPTER or word.end() - start > CHARS_PER_CHAPTER):
            yield paragraph[start:end]
            count = 0
        if not count:
            start = word.start()
        end = word.end()
        if end - start > CHARS_PER_CHAPTER:
            # An unspaced token (e.g. Chinese prose) has no word boundary to use.
            for offset in range(start, end, CHARS_PER_CHAPTER):
                yield paragraph[offset:min(offset + CHARS_PER_CHAPTER, end)]
            count = 0
        else:
            count += 1
    if count:
        yield paragraph[start:end]


def _chunk_text(text: str) -> list[dict]:
    """Prefer paragraph breaks; split oversized paragraphs without losing tails."""
    chunks: list[str] = []
    pending: list[str] = []
    word_count = char_count = 0

    def flush() -> None:
        nonlocal pending, word_count, char_count
        if pending:
            chunks.append("\n\n".join(pending))
        pending, word_count, char_count = [], 0, 0

    for paragraph in re.split(r"\n\s*\n", text):
        # Stream word spans rather than materializing millions of match objects
        # when a large TXT has no paragraph breaks.
        for part in _paragraph_parts(paragraph):
            count = len(part.split())
            if pending and (word_count + count > WORDS_PER_CHAPTER or char_count + len(part) + 2 > CHARS_PER_CHAPTER):
                flush()
            pending.append(part)
            word_count += count
            char_count += len(part) + 2
    flush()
    return [{"title": f"Chương {i + 1}", "text": chunk} for i, chunk in enumerate(chunks)]


def split_text_into_chapters(text: str) -> list[dict]:
    text = normalize_text(text)
    if not text:
        return []
    sections: list[dict] = []
    title: str | None = None
    lines: list[str] = []
    preamble: list[str] = []

    def flush() -> None:
        body = "\n".join(lines).strip()
        if title and body:
            sections.append({"title": title, "text": "\n\n".join(preamble + [body])})
            preamble.clear()
        elif title:
            # Consecutive headings (usually a TOC) must not create empty
            # chapters. Retain their text so a short note is never discarded.
            preamble.append(title)
        elif body:
            preamble.append(body)

    for line in text.splitlines():
        heading = chapter_heading(line)
        if heading:
            flush()
            title, lines = heading, []
        else:
            lines.append(line)
    flush()
    if not sections:
        return _chunk_text(text)
    if preamble:
        sections[-1]["text"] += "\n\n" + "\n\n".join(preamble)
    return sections
