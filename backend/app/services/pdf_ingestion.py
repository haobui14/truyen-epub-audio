"""Page-wise PDF extraction: bounded OCR, margin cleanup, readable paragraphs."""

import logging
import math
import re
from collections import Counter

from app.services.text_ingestion import chapter_heading, normalize_text

logger = logging.getLogger(__name__)
OCR_TIMEOUT_SECONDS = 60
MAX_OCR_PIXELS = 12_000_000
MAX_OCR_DIMENSION = 4096
_PAGE_NUMBER_RE = re.compile(r"^[-–—\s]*(?:(?:page|trang)\s+)?\d+(?:\s*(?:/|of)\s*\d+)?[-–—\s]*$", re.I)


def _needs_ocr(page, text: str) -> bool:
    import fitz

    letters = sum(c.isalnum() for c in text)
    if text.count("\ufffd") > max(2, len(text) * 0.02):
        return True
    page_area = max(page.rect.get_area(), 1)
    # A full-page scan can still have a digital page number or running header.
    image_area = sum((fitz.Rect(info["bbox"]) & page.rect).get_area() for info in page.get_image_info())
    if image_area / page_area >= 0.5:
        return letters < 80
    # Vector outlines can visually contain text without an extractable layer.
    return letters < 80 and len(page.get_drawings()) > 1000


def _ocr_languages() -> str:
    import pytesseract

    try:
        available = set(pytesseract.get_languages(config=""))
    except (pytesseract.TesseractNotFoundError, OSError) as exc:
        raise ValueError("PDF có trang scan nhưng máy chủ chưa có Tesseract OCR. Cần cài Tesseract và dữ liệu ngôn ngữ vie, eng.") from exc
    if not {"vie", "eng"} <= available:
        raise ValueError("OCR thiếu dữ liệu tiếng Việt/Anh. Cần cài ngôn ngữ vie và eng trên máy chủ rồi thử lại.")
    return "vie+eng"


def _ocr_page(page, languages: str) -> str:
    import fitz
    import pytesseract
    from PIL import Image

    scale = min(
        200 / 72,
        math.sqrt(MAX_OCR_PIXELS / max(page.rect.get_area(), 1)),
        MAX_OCR_DIMENSION / max(page.rect.width, page.rect.height, 1),
    )
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
    with Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples) as image:
        try:
            text = pytesseract.image_to_string(image, lang=languages, timeout=OCR_TIMEOUT_SECONDS)
        except (RuntimeError, pytesseract.TesseractError, pytesseract.TesseractNotFoundError) as exc:
            raise ValueError(f"OCR thất bại ở trang {page.number + 1}. Hãy kiểm tra chất lượng bản scan hoặc chia PDF thành các file nhỏ hơn rồi thử lại.") from exc
        if not text.strip():
            # Truly blank scanned sheets are harmless; a nonblank sheet with
            # no OCR result must not silently vanish from the imported book.
            with image.convert("L") as grayscale:
                if grayscale.getextrema()[0] < 240:
                    raise ValueError(f"Không đọc được chữ ở trang scan {page.number + 1}. Hãy dùng bản scan rõ hơn hoặc PDF có lớp văn bản.")
        return text


def _reflow_block(text: str) -> str:
    """Join hard-wrapped prose while respecting headings, dialogue and blank lines."""
    paragraphs: list[str] = []
    pending = ""
    for raw in normalize_text(text).splitlines():
        line = raw.strip()
        heading = chapter_heading(line)
        if not line or heading:
            if pending:
                paragraphs.append(pending)
                pending = ""
            if heading:
                paragraphs.append(line)
            continue
        if pending and (line.startswith(("—", "–", "- ", '"', "“", "•")) or pending.endswith((".", "!", "?", "。", "！", "？", "”", '"'))):
            paragraphs.append(pending)
            pending = ""
        if pending.endswith("-") and len(pending) > 1 and pending[-2].isalpha() and line[0].islower():
            pending = pending[:-1] + line
        else:
            pending = f"{pending} {line}".strip()
    if pending:
        paragraphs.append(pending)
    return "\n\n".join(paragraphs)


def _clean_pages(pages: list[list[tuple[str, str | None]]]) -> str:
    # Only repeated text physically in the top/bottom margins is removable.
    # Counting each page once avoids erasing repeated dialogue in the body.
    counts: Counter = Counter()
    for blocks in pages:
        counts.update({(margin, text) for text, margin in blocks if margin and len(text) <= 120})
    # Book/author headers often alternate on odd and even pages.
    threshold = max(3, math.ceil(len(pages) * 0.4))
    repeated = {key for key, count in counts.items() if count >= threshold}
    seen_headings: set[tuple[str, str]] = set()
    cleaned: list[str] = []
    for blocks in pages:
        parts = []
        for text, margin in blocks:
            if margin and _PAGE_NUMBER_RE.fullmatch(text):
                continue
            if (margin, text) in repeated:
                if not chapter_heading(text) or (margin, text) in seen_headings:
                    continue
                # Keep the first occurrence of a chapter title running header.
                seen_headings.add((margin, text))
            reflowed = _reflow_block(text)
            if reflowed:
                parts.append(reflowed)
        cleaned.append("\n\n".join(parts))
    return "\n\n".join(page for page in cleaned if page)


def extract_pdf_text(data: bytes) -> str:
    import fitz

    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except (fitz.FileDataError, RuntimeError) as exc:
        raise ValueError("File PDF bị hỏng hoặc không đúng định dạng. Hãy xuất lại PDF rồi tải lên.") from exc
    with doc:
        if doc.needs_pass and not doc.authenticate(""):
            raise ValueError("PDF được bảo vệ bằng mật khẩu. Hãy mở khóa và lưu bản không có mật khẩu trước khi tải lên.")
        if not doc.page_count:
            raise ValueError("File PDF không có trang nào.")
        pages: list[list[tuple[str, str | None]]] = []
        languages: str | None = None
        ocr_count = 0
        for page in doc:
            blocks = [block for block in page.get_text("blocks", sort=True) if block[6] == 0]
            native_text = "\n".join(block[4] for block in blocks)
            if _needs_ocr(page, native_text):
                languages = languages or _ocr_languages()
                text = normalize_text(_ocr_page(page, languages))
                # Blank scanned pages may retain a useful digital page label.
                text = text or normalize_text(native_text)
                # OCR has no geometric block positions: preserve all its text
                # instead of guessing which first/last lines are running heads.
                pages.append([(text, None)])
                ocr_count += 1
            else:
                page_blocks = []
                for block in blocks:
                    text = normalize_text(block[4])
                    if not text:
                        continue
                    margin = "top" if block[3] < page.rect.height * 0.08 else "bottom" if block[1] > page.rect.height * 0.92 else None
                    page_blocks.append((text, margin))
                pages.append(page_blocks)
        text = _clean_pages(pages)
        if not text or not any(c.isalnum() for c in text):
            raise ValueError("Không tìm thấy nội dung có thể đọc trong PDF. Hãy kiểm tra file hoặc dùng bản scan rõ hơn.")
        logger.info("PDF extraction: %d pages, %d OCR pages", doc.page_count, ocr_count)
        return text
