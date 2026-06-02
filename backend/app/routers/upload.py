import asyncio
import io
import uuid
import zipfile
import logging

from typing import Optional

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends

from app.database import get_client
from app.config import settings
from app.dependencies import get_admin_user
from app.services import storage_service, epub_parser
from app.services.converter import txt_to_epub, pdf_to_epub, prc_to_epub

router = APIRouter(prefix="/api", tags=["upload"])
logger = logging.getLogger(__name__)

# Keep strong references to background tasks so GC doesn't collect them early
_background_tasks: set = set()

VALID_VOICES = ["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"]
VALID_COVER_TYPES = {"image/jpeg", "image/png", "image/webp"}
VALID_EXTENSIONS = {".epub", ".pdf", ".txt", ".prc", ".mobi"}


def _validate_upload_shape(content: bytes, ext: str) -> None:
    """Cheap pre-flight check before we touch Storage or the DB. EPUBs must be
    valid zip files containing META-INF/container.xml; PDFs must start with the
    %PDF marker. We catch obvious garbage here so we don't end up with a stuck
    book row in 'parsing' status while the background task crashes."""
    if ext == ".epub":
        if not zipfile.is_zipfile(io.BytesIO(content)):
            raise HTTPException(
                status_code=400,
                detail="File is not a valid EPUB (zip signature missing)",
            )
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                names = set(zf.namelist())
                if "META-INF/container.xml" not in names:
                    raise HTTPException(
                        status_code=400,
                        detail="EPUB is missing META-INF/container.xml — file appears corrupt",
                    )
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="EPUB archive is corrupt")
    elif ext == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise HTTPException(
                status_code=400,
                detail="File is not a valid PDF (missing %PDF- header)",
            )
    # .txt / .prc / .mobi: no cheap structural check — let the converter try.


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
            detail="Only .epub, .pdf, .txt, .prc, and .mobi files are accepted",
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
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # Pre-flight structural validation — fail fast before we touch Storage or
    # create a book row. Avoids stuck rows that need manual cleanup later.
    _validate_upload_shape(content, ext)

    book_id = str(uuid.uuid4())
    db = get_client()
    base_title = filename[: -len(ext)]  # strip extension

    # Upload cover + original file in parallel — they're independent and the
    # cover is usually small enough to finish well before the EPUB. Halves
    # perceived upload time for users who include a cover. Cover failure is
    # non-fatal; original-file failure rolls back the whole upload.
    cover_url: Optional[str] = None
    cover_path: Optional[str] = None
    if cover_content:
        cext = cover_content_type.split("/")[-1].replace("jpeg", "jpg")  # type: ignore[union-attr]
        cover_path = f"{book_id}/cover.{cext}"

    storage_path = f"{book_id}/original{ext}"
    orig_content_type = {
        ".epub": "application/epub+zip",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".prc": "application/x-mobipocket-ebook",
        ".mobi": "application/x-mobipocket-ebook",
    }[ext]

    async def _upload_cover() -> Optional[str]:
        if not cover_content or not cover_path:
            return None
        try:
            return await storage_service.upload_bytes(
                bucket="covers",
                path=cover_path,
                data=cover_content,
                content_type=cover_content_type,  # type: ignore[arg-type]
            )
        except Exception as e:
            logger.warning(f"Cover upload failed for book {book_id}: {e}")
            return None

    async def _upload_original() -> None:
        await storage_service.upload_bytes(
            bucket="epub-uploads",
            path=storage_path,
            data=content,
            content_type=orig_content_type,
        )

    try:
        cover_url, _ = await asyncio.gather(_upload_cover(), _upload_original())
    except Exception as e:
        logger.error(f"Original-file upload failed for book {book_id}: {e}")
        # Roll back the cover we may have already written. Don't await — if it
        # also fails we don't want to mask the real error.
        if cover_path:
            asyncio.create_task(
                storage_service.delete_path("covers", cover_path)
            )
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

    # Insert book row only AFTER both uploads succeeded. If we crash earlier
    # there's no orphan row in the DB.
    db.table("books").insert({
        "id": book_id,
        "title": base_title,
        "voice": voice,
        "status": "parsing",
        "total_chapters": 0,
        **({"cover_url": cover_url} if cover_url else {}),
    }).execute()

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
        elif ext in (".prc", ".mobi"):
            logger.info(f"Book {book_id}: converting PRC/MOBI → EPUB")
            epub_bytes = await asyncio.to_thread(prc_to_epub, content, title)
        else:  # .pdf
            logger.info(f"Book {book_id}: converting PDF → EPUB")
            epub_bytes = await asyncio.to_thread(pdf_to_epub, content, title)

        await epub_parser.parse_epub_task(book_id, epub_bytes)

    except Exception as e:
        logger.exception(f"Book {book_id}: conversion failed: {e}")
        db.table("books").update({
            "status": "error",
            "error_message": f"Chuyển đổi file sang EPUB thất bại: {type(e).__name__}: {e}"[:1000],
        }).eq("id", book_id).execute()
