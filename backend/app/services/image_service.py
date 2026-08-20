"""Cover-image optimization.

Covers arrive as arbitrary admin/EPUB images (up to 5MB) but are only ever
displayed as thumbnails (~240px wide cards). The web app is saved by Vercel's
next/image optimizer, but the Android build renders images UNOPTIMIZED
(next.config.ts sets `unoptimized: true` under BUILD_TARGET=capacitor), so
every phone downloads the raw stored bytes. Re-encoding to a bounded WebP at
upload time cuts a typical cover to tens of KB with no visible difference at
display size — and shrinks Supabase egress with it.

Pillow is already a transitive dependency (pdf2image/pytesseract) and is
pinned explicitly in requirements.txt.
"""
import io
import logging
import time

logger = logging.getLogger(__name__)

# 2x the largest rendered size (~240px-wide cards) so hi-DPI screens stay
# sharp; the height bound guards against extreme portrait scans.
MAX_WIDTH = 480
MAX_HEIGHT = 720
WEBP_QUALITY = 80


def optimize_cover(data: bytes) -> "tuple[bytes, str, str] | None":
    """Re-encode an image as a bounded WebP.

    Returns (bytes, content_type, extension) on success, or None when the
    input can't be decoded or the re-encode isn't actually smaller — callers
    keep the original in that case. Never raises.
    """
    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(data))
        # Apply EXIF rotation before it's lost with the metadata.
        img = ImageOps.exif_transpose(img)
        if img.mode in ("P", "PA", "LA"):
            img = img.convert("RGBA")
        elif img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        img.thumbnail((MAX_WIDTH, MAX_HEIGHT), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="WEBP", quality=WEBP_QUALITY, method=4)
        result = out.getvalue()
        if len(result) >= len(data):
            return None  # already tiny — keep the original bytes
        return result, "image/webp", "webp"
    except Exception as e:
        logger.warning(f"Cover optimization failed, keeping original: {e}")
        return None


def versioned_cover_url(url: str) -> str:
    """Append a version query param to a cover's public URL.

    Supabase's Storage CDN does not invalidate on upsert (same lesson as
    chapter text): replacing a cover at the same object path keeps serving the
    OLD bytes until the CDN TTL. Baking a version into the stored URL makes
    every replacement a distinct cache key.
    """
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}v={int(time.time())}"
