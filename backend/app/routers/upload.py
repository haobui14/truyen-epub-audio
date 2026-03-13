import asyncio
import uuid
import logging

from typing import Optional

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends

from app.database import get_client
from app.config import settings
from app.dependencies import get_admin_user
from app.services import storage_service, epub_parser
from app.services.converter import txt_to_epub, pdf_to_epub

router = APIRouter(prefix="/api", tags=["upload"])
logger = logging.getLogger(__name__)

# Keep strong references to background tasks so GC doesn't collect them early
_background_tasks: set = set()

VALID_VOICES = ["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"]
VALID_COVER_TYPES = {"image/jpeg", "image/png", "image/webp"}
VALID_EXTENSIONS = {".epub", ".pdf", ".txt"}


@router.post("/upload")
async def upload_book(
    file: UploadFile = File(...),
    voice: str = Form(default="vi-VN-HoaiMyNeural"),
    cover: Optional[UploadFile] = File(None),
    _admin: dict = Depends(get_admin_user),
):
    # Validate file type
    filename = file.filename or ""
    fname_lower = filename.lower()
    ext = next((e for e in VALID_EXTENSIONS if fname_lower.endswith(e)), None)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail="Only .epub, .pdf, and .txt files are accepted",
        )

    if voice not in VALID_VOICES:
        raise HTTPException(status_code=400, detail=f"Invalid voice. Choose from: {VALID_VOICES}")

    # Validate cover if provided
    cover_content: Optional[bytes] = None
    cover_content_type: Optional[str] = None
    if cover and cover.filename:
        cover_content_type = cover.content_type or "image/jpeg"
        if cover_content_type not in VALID_COVER_TYPES:
            raise HTTPException(status_code=400, detail="Cover must be a JPEG, PNG, or WebP image")
        cover_content = await cover.read()
        if len(cover_content) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Cover image must be under 5MB")

    # Read and size-check uploaded file
    content = await file.read()
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max {settings.max_upload_size_mb}MB",
        )

    book_id = str(uuid.uuid4())
    db = get_client()
    base_title = filename[: -len(ext)]  # strip extension

    # Upload cover
    cover_url: Optional[str] = None
    if cover_content:
        cext = cover_content_type.split("/")[-1].replace("jpeg", "jpg")  # type: ignore[union-attr]
        cover_path = f"{book_id}/cover.{cext}"
        try:
            cover_url = await storage_service.upload_bytes(
                bucket="covers",
                path=cover_path,
                data=cover_content,
                content_type=cover_content_type,  # type: ignore[arg-type]
            )
        except Exception as e:
            logger.warning(f"Cover upload failed for book {book_id}: {e}")

    # Insert book row (status=parsing)
    db.table("books").insert({
        "id": book_id,
        "title": base_title,
        "voice": voice,
        "status": "parsing",
        "total_chapters": 0,
        **({"cover_url": cover_url} if cover_url else {}),
    }).execute()

    # Store the original file
    storage_path = f"{book_id}/original{ext}"
    orig_content_type = {
        ".epub": "application/epub+zip",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
    }[ext]
    try:
        await storage_service.upload_bytes(
            bucket="epub-uploads",
            path=storage_path,
            data=content,
            content_type=orig_content_type,
        )
    except Exception as e:
        logger.error(f"Storage upload failed for book {book_id}: {e}")
        db.table("books").delete().eq("id", book_id).execute()
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

    # Convert to EPUB if needed, then parse
    task = asyncio.create_task(_convert_and_parse(book_id, content, ext, base_title))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    logger.info(f"Book {book_id} ({ext}) uploaded, conversion+parsing started")
    return {"book_id": book_id, "status": "parsing"}


async def _convert_and_parse(
    book_id: str, content: bytes, ext: str, title: str
) -> None:
    """Convert TXT/PDF → EPUB (if needed) then run the standard EPUB parser."""
    db = get_client()
    try:
        if ext == ".epub":
            epub_bytes = content
        elif ext == ".txt":
            logger.info(f"Book {book_id}: converting TXT → EPUB")
            epub_bytes = await asyncio.to_thread(txt_to_epub, content, title)
        else:  # .pdf
            logger.info(f"Book {book_id}: converting PDF → EPUB")
            epub_bytes = await asyncio.to_thread(pdf_to_epub, content, title)

        await epub_parser.parse_epub_task(book_id, epub_bytes)

    except Exception as e:
        logger.exception(f"Book {book_id}: conversion failed: {e}")
        db.table("books").update({"status": "error"}).eq("id", book_id).execute()
