from fastapi import APIRouter, HTTPException, Query, Depends, UploadFile, File, Form
from typing import List, Optional
from pydantic import BaseModel

from app.database import get_client
from app.dependencies import get_admin_user
from app.models.book import BookResponse
from app.models.chapter import ChapterResponse, AudioSummary, PaginatedChaptersResponse
from app.services import storage_service

router = APIRouter(prefix="/api/books", tags=["books"])


def _attach_genres(rows: list) -> list:
    """Flatten nested book_genres → genres into a top-level list."""
    out = []
    for row in rows:
        raw_bg = row.pop("book_genres", []) or []
        genres = [bg["genres"] for bg in raw_bg if bg.get("genres")]
        out.append({**row, "genres": genres})
    return out


_BOOK_SELECT = (
    "id,title,author,cover_url,voice,status,total_chapters,created_at,"
    "book_genres(genres(id,name,color))"
)


@router.get("", response_model=List[BookResponse])
async def list_books():
    db = get_client()
    result = db.table("books").select(_BOOK_SELECT).order("created_at", desc=True).execute()
    return _attach_genres(result.data)


@router.get("/{book_id}", response_model=BookResponse)
async def get_book(book_id: str):
    db = get_client()
    result = db.table("books").select(_BOOK_SELECT).eq("id", book_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Book not found")
    return _attach_genres([result.data])[0]


@router.get("/{book_id}/chapters", response_model=PaginatedChaptersResponse)
async def get_book_chapters(
    book_id: str,
    page: int = Query(1, ge=1, description="Page number (1-based)"),
    page_size: int = Query(100, ge=1, le=10000, description="Chapters per page"),
):
    db = get_client()
    # Verify book exists
    book = db.table("books").select("id,total_chapters").eq("id", book_id).single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    total = book.data.get("total_chapters", 0)

    # Calculate range for Supabase (0-based inclusive)
    offset = (page - 1) * page_size
    end = offset + page_size - 1

    chapters = db.table("chapters").select(
        "id,book_id,chapter_index,title,word_count,status,error_message,created_at"
    ).eq("book_id", book_id).order("chapter_index").range(offset, end).execute()

    chapter_ids = {ch["id"] for ch in (chapters.data or [])}

    # Fetch audio info for this book, then filter to current page's chapters
    audio_map = {}
    if chapter_ids:
        audio_result = db.table("audio_files").select(
            "chapter_id,public_url,duration_seconds,file_size_bytes"
        ).eq("book_id", book_id).execute()
        for a in (audio_result.data or []):
            if a["chapter_id"] in chapter_ids:
                audio_map[a["chapter_id"]] = a

    items = []
    for ch in (chapters.data or []):
        audio = audio_map.get(ch["id"])
        ch_response = ChapterResponse(
            **ch,
            audio=AudioSummary(**audio) if audio else None,
        )
        items.append(ch_response)

    total_pages = max(1, -(-total // page_size))  # ceil division

    return PaginatedChaptersResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


VALID_COVER_TYPES = {"image/jpeg", "image/png", "image/webp"}


@router.patch("/{book_id}", response_model=BookResponse)
async def update_book(
    book_id: str,
    title: Optional[str] = Form(None),
    author: Optional[str] = Form(None),
    cover: Optional[UploadFile] = File(None),
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: update book metadata (title, author, cover image)."""
    db = get_client()
    book = db.table("books").select("id,cover_url").eq("id", book_id).single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    updates: dict = {}
    if title is not None:
        t = title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        updates["title"] = t
    if author is not None:
        updates["author"] = author.strip() or None

    if cover and cover.filename:
        content_type = cover.content_type or "image/jpeg"
        if content_type not in VALID_COVER_TYPES:
            raise HTTPException(status_code=400, detail="Cover must be JPEG, PNG, or WebP")
        cover_data = await cover.read()
        if len(cover_data) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Cover image must be under 5MB")
        ext = content_type.split("/")[-1].replace("jpeg", "jpg")
        cover_path = f"covers/{book_id}/cover.{ext}"
        try:
            cover_url = await storage_service.upload_bytes(
                bucket="covers",
                path=cover_path,
                data=cover_data,
                content_type=content_type,
            )
            updates["cover_url"] = cover_url
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Cover upload failed: {e}")

    if updates:
        db.table("books").update(updates).eq("id", book_id).execute()

    result = db.table("books").select(_BOOK_SELECT).eq("id", book_id).single().execute()
    return _attach_genres([result.data])[0]


@router.delete("/{book_id}")
async def delete_book(book_id: str, _admin: dict = Depends(get_admin_user)):
    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Delete from storage (best effort)
    await storage_service.delete_folder("audio", f"audio/{book_id}")
    await storage_service.delete_folder("covers", f"covers/{book_id}")
    await storage_service.delete_folder("epub-uploads", f"epub-uploads/{book_id}")

    # Delete from DB (cascades to chapters + audio_files)
    db.table("books").delete().eq("id", book_id).execute()
    return {"message": "Book deleted"}


class ChapterCreateBody(BaseModel):
    chapter_index: int
    title: str
    text_content: str


@router.post("/{book_id}/chapters", response_model=ChapterResponse, status_code=201)
async def create_chapter(
    book_id: str,
    body: ChapterCreateBody,
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: manually add a chapter to an existing book."""
    if body.chapter_index < 0:
        raise HTTPException(status_code=400, detail="chapter_index must be >= 0")
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")
    text_content = body.text_content.strip()

    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    word_count = len(text_content.split()) if text_content else 0

    try:
        result = db.table("chapters").insert({
            "book_id": book_id,
            "chapter_index": body.chapter_index,
            "title": title,
            "text_content": text_content,
            "word_count": word_count,
            "status": "pending",
        }).execute()
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"Chapter index {body.chapter_index} already exists for this book",
            )
        raise HTTPException(status_code=500, detail="Failed to create chapter")

    # Recalculate total_chapters
    count_result = db.table("chapters").select("id", count="exact").eq("book_id", book_id).execute()
    total = count_result.count or 0
    db.table("books").update({"total_chapters": total}).eq("id", book_id).execute()

    ch = result.data[0]
    return ChapterResponse(**ch, audio=None)
