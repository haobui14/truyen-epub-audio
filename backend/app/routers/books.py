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
    "id,title,author,description,cover_url,voice,status,total_chapters,created_at,"
    "is_featured,featured_label,story_status,"
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
    result = db.table("books").select(_BOOK_SELECT).eq("id", book_id).maybe_single().execute()
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
    book = db.table("books").select("id,total_chapters").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    total = book.data.get("total_chapters", 0)

    # Calculate range for Supabase (0-based inclusive)
    offset = (page - 1) * page_size
    end = offset + page_size - 1

    chapters = db.table("chapters").select(
        "id,book_id,chapter_index,title,word_count,status,error_message,created_at,audio_url,audio_duration_seconds,audio_file_size_bytes"
    ).eq("book_id", book_id).order("chapter_index").range(offset, end).execute()

    items = []
    for ch in (chapters.data or []):
        audio = AudioSummary(
            audio_url=ch["audio_url"],
            audio_duration_seconds=ch.get("audio_duration_seconds"),
            audio_file_size_bytes=ch.get("audio_file_size_bytes"),
        ) if ch.get("audio_url") else None
        ch_response = ChapterResponse(
            **{k: v for k, v in ch.items() if k in ChapterResponse.model_fields},
            audio=audio,
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
    description: Optional[str] = Form(None),
    story_status: Optional[str] = Form(None),
    cover: Optional[UploadFile] = File(None),
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: update book metadata (title, author, cover image, story status)."""
    db = get_client()
    book = db.table("books").select("id,cover_url").eq("id", book_id).maybe_single().execute()
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
    if description is not None:
        updates["description"] = description.strip() or None
    if story_status is not None:
        if story_status not in ("ongoing", "completed", "unknown"):
            raise HTTPException(status_code=400, detail="story_status must be 'ongoing', 'completed', or 'unknown'")
        updates["story_status"] = story_status

    if cover and cover.filename:
        if content_type not in VALID_COVER_TYPES:
            raise HTTPException(status_code=400, detail="Cover must be JPEG, PNG, or WebP")
        cover_data = await cover.read()
        if len(cover_data) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Cover image must be under 5MB")
        ext = content_type.split("/")[-1].replace("jpeg", "jpg")
        cover_path = f"{book_id}/cover.{ext}"
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

    result = db.table("books").select(_BOOK_SELECT).eq("id", book_id).maybe_single().execute()
    return _attach_genres([result.data])[0]


@router.delete("/{book_id}")
async def delete_book(book_id: str, _admin: dict = Depends(get_admin_user)):
    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Delete from storage (best effort)
    await storage_service.delete_folder("audio", book_id)
    await storage_service.delete_folder("covers", book_id)
    await storage_service.delete_folder("epub-uploads", book_id)

    # Delete from DB (cascades to chapters + audio_files)
    db.table("books").delete().eq("id", book_id).execute()
    return {"message": "Book deleted"}


class ChapterCreateBody(BaseModel):
    chapter_index: int
    title: str
    text_content: str


class FeatureBookBody(BaseModel):
    is_featured: bool
    featured_label: Optional[str] = None  # e.g. 'Weekly Star', 'Hot', 'Mới'


@router.patch("/{book_id}/feature", response_model=BookResponse)
async def feature_book(
    book_id: str,
    body: FeatureBookBody,
    _admin: dict = Depends(get_admin_user),
):
    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Un-feature every other book first so only one spotlight exists at a time.
    if body.is_featured:
        db.table("books").update({"is_featured": False, "featured_label": None}).neq("id", book_id).execute()

    db.table("books").update({
        "is_featured": body.is_featured,
        "featured_label": body.featured_label if body.is_featured else None,
    }).eq("id", book_id).execute()

    result = db.table("books").select(_BOOK_SELECT).eq("id", book_id).maybe_single().execute()
    return _attach_genres([result.data])[0]


@router.post("/{book_id}/auto-split")
async def auto_split_book(
    book_id: str,
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: join all chapters and re-split by Chương/Chapter headers.

    Returns old_count, new_count, and any chapters whose header had no body.
    """
    from app.services.epub_parser import split_text_by_headers
    import uuid as _uuid

    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Fetch ALL chapters in reading order.
    # Supabase PostgREST defaults to 1000 rows; use a high explicit limit so
    # chapters that sit between two merged items are never silently dropped.
    chapters_result = db.table("chapters").select(
        "id,chapter_index,text_content"
    ).eq("book_id", book_id).order("chapter_index").limit(100_000).execute()

    chapters = chapters_result.data or []
    old_count = len(chapters)
    if not chapters:
        raise HTTPException(status_code=400, detail="No chapters to split")

    # Merge every chapter's text in reading order, then split by headers.
    # Using "\n" ensures a line break between chapters even when a chapter's
    # text_content has no trailing newline.
    combined = "\n".join((ch.get("text_content") or "") for ch in chapters)
    parts = split_text_by_headers(combined)

    if not parts:
        raise HTTPException(status_code=400, detail="No chapter headers detected in text")

    missing_chapters = [
        {"title": p["title"], "chapter_index": i}
        for i, p in enumerate(parts)
        if not p["has_body"]
    ]

    # Build new chapter rows. Use a large offset (1_000_000 + i) so the
    # temporary indices don't collide with existing rows (which have index < 1_000_000).
    OFFSET = 1_000_000
    new_chapters = [
        {
            "id": str(_uuid.uuid4()),
            "book_id": book_id,
            "chapter_index": OFFSET + i,
            "title": p["title"],
            "text_content": p["text_content"],
            "word_count": len(p["text_content"].split()),
            "status": "pending",
        }
        for i, p in enumerate(parts)
    ]

    # INSERT new rows first. If this fails (e.g. DB timeout) the old chapters
    # are still intact and the book is not left empty.
    # Batch size is kept at 1 to avoid Supabase statement timeouts when
    # text_content is large (novel chapters can be hundreds of KB each).
    BATCH_SIZE = 1
    inserted_ids: list[str] = []
    try:
        for i in range(0, len(new_chapters), BATCH_SIZE):
            db.table("chapters").insert(new_chapters[i : i + BATCH_SIZE]).execute()
            inserted_ids.extend(ch["id"] for ch in new_chapters[i : i + BATCH_SIZE])
    except Exception as insert_err:
        # Roll back any rows we managed to insert before the failure
        if inserted_ids:
            try:
                db.table("chapters").delete().eq("book_id", book_id).gte("chapter_index", OFFSET).execute()
            except Exception:
                pass
        raise HTTPException(
            status_code=500,
            detail=f"Failed to insert new chapters (no data was lost): {insert_err}",
        )

    # Only now that new chapters are safely stored: delete old chapters & audio
    chapter_ids = [ch["id"] for ch in chapters]
    for ch in chapters:
        try:
            await storage_service.delete_path("audio", f"{book_id}/{ch['id']}.mp3")
        except Exception:
            pass
    # Delete old chapters by book_id + chapter_index < OFFSET to avoid
    # PostgREST "JSON could not be generated" errors from large .in_() lists.
    db.table("chapters").delete().eq("book_id", book_id).lt("chapter_index", OFFSET).execute()

    # Normalize chapter_index back to 0-based now that old rows are gone.
    # We can't do "SET chapter_index = chapter_index - OFFSET" via PostgREST,
    # so update each row individually. For typical book sizes this is acceptable.
    for ch in new_chapters:
        real_index = ch["chapter_index"] - OFFSET
        db.table("chapters").update({"chapter_index": real_index}).eq("id", ch["id"]).execute()

    new_count = len(new_chapters)
    db.table("books").update({"total_chapters": new_count}).eq("id", book_id).execute()

    return {
        "old_count": old_count,
        "new_count": new_count,
        "missing_chapters": missing_chapters,
    }


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
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    word_count = len(text_content.split()) if text_content else 0

    # Check whether the requested index is already taken; if so, shift
    # all chapters at that index and above up by one to make room.
    existing = (
        db.table("chapters")
        .select("id")
        .eq("book_id", book_id)
        .eq("chapter_index", body.chapter_index)
        .limit(1)
        .execute()
    )
    if existing.data:
        db.rpc("shift_chapters_up", {
            "p_book_id": book_id,
            "p_insert_index": body.chapter_index,
        }).execute()

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
        raise HTTPException(status_code=500, detail="Failed to create chapter")

    # Recalculate total_chapters
    count_result = db.table("chapters").select("id", count="exact").eq("book_id", book_id).execute()
    total = count_result.count or 0
    db.table("books").update({"total_chapters": total}).eq("id", book_id).execute()

    ch = result.data[0]
    return ChapterResponse(**ch, audio=None)
