from fastapi import APIRouter, HTTPException, Query
from typing import List

from app.database import get_client
from app.models.book import BookResponse
from app.models.chapter import ChapterResponse, AudioSummary, PaginatedChaptersResponse
from app.services import storage_service

router = APIRouter(prefix="/api/books", tags=["books"])


@router.get("", response_model=List[BookResponse])
async def list_books():
    db = get_client()
    result = db.table("books").select(
        "id,title,author,cover_url,voice,status,total_chapters,created_at"
    ).order("created_at", desc=True).execute()
    return result.data


@router.get("/{book_id}", response_model=BookResponse)
async def get_book(book_id: str):
    db = get_client()
    result = db.table("books").select(
        "id,title,author,cover_url,voice,status,total_chapters,created_at"
    ).eq("id", book_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Book not found")
    return result.data


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


@router.delete("/{book_id}")
async def delete_book(book_id: str):
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
