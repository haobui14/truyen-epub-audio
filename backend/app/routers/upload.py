import asyncio
import uuid
import logging

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends

from app.database import get_client
from app.config import settings
from app.dependencies import get_admin_user
from app.services import storage_service, epub_parser

router = APIRouter(prefix="/api", tags=["upload"])
logger = logging.getLogger(__name__)

VALID_VOICES = ["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"]


@router.post("/upload")
async def upload_epub(
    file: UploadFile = File(...),
    voice: str = Form(default="vi-VN-HoaiMyNeural"),
    _admin: dict = Depends(get_admin_user),
):
    # Validate file type
    filename = file.filename or ""
    if not filename.lower().endswith(".epub"):
        raise HTTPException(status_code=400, detail="Only .epub files are accepted")

    if voice not in VALID_VOICES:
        raise HTTPException(status_code=400, detail=f"Invalid voice. Choose from: {VALID_VOICES}")

    # Check file size
    content = await file.read()
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max {settings.max_upload_size_mb}MB",
        )

    book_id = str(uuid.uuid4())
    db = get_client()

    # Insert book row immediately
    db.table("books").insert({
        "id": book_id,
        "title": filename.replace(".epub", ""),
        "voice": voice,
        "status": "parsing",
        "total_chapters": 0,
    }).execute()

    # Upload raw EPUB to storage
    epub_storage_path = f"epub-uploads/{book_id}/original.epub"
    try:
        await storage_service.upload_bytes(
            bucket="epub-uploads",
            path=epub_storage_path,
            data=content,
            content_type="application/epub+zip",
        )
    except Exception as e:
        logger.error(f"Storage upload failed for book {book_id}: {e}")
        db.table("books").delete().eq("id", book_id).execute()
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

    # Start async parsing in background
    asyncio.create_task(epub_parser.parse_epub_task(book_id, content))

    logger.info(f"Book {book_id} uploaded, parsing started")
    return {"book_id": book_id, "status": "parsing"}
