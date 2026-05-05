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
        content_type = cover.content_type or ""
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
    await storage_service.delete_folder("chapter-text", book_id)

    # Delete from DB (cascades to chapters)
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


class StripStringRequest(BaseModel):
    target: str


@router.post("/{book_id}/strip-string")
async def strip_string_from_chapters(
    book_id: str,
    body: StripStringRequest,
    _admin: dict = Depends(get_admin_user),
):
    """Remove every occurrence of a literal string from all chapters' text."""
    import asyncio
    if not body.target:
        raise HTTPException(status_code=400, detail="target string cannot be empty")

    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Paginate through all chapters; for each, download text from Storage,
    # remove every occurrence of target, re-upload + update word_count.
    PAGE_SIZE = 500
    CONCURRENCY = 10
    sem = asyncio.Semaphore(CONCURRENCY)
    target = body.target
    updated_count = 0

    async def _strip_one(ch: dict) -> bool:
        async with sem:
            text = await storage_service.get_chapter_text(ch["id"])
            if target not in text:
                return False
            new_text = text.replace(target, "")
            new_word_count = len(new_text.split()) if new_text.strip() else 0
            await storage_service.write_chapter_text(book_id, ch["id"], new_text)
            db.table("chapters").update({
                "word_count": new_word_count,
            }).eq("id", ch["id"]).execute()
            return True

    fetch_offset = 0
    while True:
        page = db.table("chapters").select("id").eq("book_id", book_id).order(
            "chapter_index"
        ).range(fetch_offset, fetch_offset + PAGE_SIZE - 1).execute()
        batch = page.data or []
        if not batch:
            break
        results = await asyncio.gather(*(_strip_one(ch) for ch in batch))
        updated_count += sum(1 for r in results if r)
        if len(batch) < PAGE_SIZE:
            break
        fetch_offset += PAGE_SIZE

    return {"updated_chapters": updated_count}


@router.post("/{book_id}/auto-split")
async def auto_split_book(
    book_id: str,
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: join all chapters and re-split by Chương/Chapter headers.

    Returns old_count, new_count, and any chapters whose header had no body.
    """
    from app.services.epub_parser import split_text_by_headers
    import asyncio
    import uuid as _uuid

    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Fetch ALL chapters in reading order using pagination.
    # PostgREST enforces a server-side max_rows cap (default 1000 on Supabase)
    # that ignores client-specified limits above it. Paginate to bypass this.
    PAGE_SIZE = 500
    chapters: list[dict] = []
    fetch_offset = 0
    while True:
        page = db.table("chapters").select(
            "id,chapter_index"
        ).eq("book_id", book_id).order("chapter_index").range(
            fetch_offset, fetch_offset + PAGE_SIZE - 1
        ).execute()
        batch = page.data or []
        chapters.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        fetch_offset += PAGE_SIZE
    old_count = len(chapters)
    if not chapters:
        raise HTTPException(status_code=400, detail="No chapters to split")

    # Download text for each chapter from Storage in parallel.
    DOWNLOAD_CONCURRENCY = 20
    dl_sem = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)

    async def _fetch_text(ch: dict) -> str:
        async with dl_sem:
            return await storage_service.get_chapter_text(ch["id"])

    chapter_texts = await asyncio.gather(*(_fetch_text(ch) for ch in chapters))

    # Merge every chapter's text in reading order, then split by headers.
    combined = "\n".join(chapter_texts)
    parts = split_text_by_headers(combined)

    if not parts:
        raise HTTPException(status_code=400, detail="No chapter headers detected in text")

    missing_chapters = [
        {"title": p["title"], "chapter_index": i}
        for i, p in enumerate(parts)
        if not p["has_body"]
    ]

    # Build new chapter rows with pre-generated UUIDs. Use a large offset
    # (1_000_000 + i) so the temporary indices don't collide with existing rows.
    OFFSET = 1_000_000
    new_chapters = [
        {
            "id": str(_uuid.uuid4()),
            "book_id": book_id,
            "chapter_index": OFFSET + i,
            "title": p["title"],
            "word_count": len(p["text_content"].split()),
            "status": "pending",
            "_text": p["text_content"],
        }
        for i, p in enumerate(parts)
    ]

    # Upload each new chapter's text to Storage in parallel.
    up_sem = asyncio.Semaphore(20)

    async def _upload_one(ch: dict) -> None:
        async with up_sem:
            ch["text_storage_path"] = await storage_service.upload_chapter_text(
                book_id, ch["id"], ch["_text"]
            )

    await asyncio.gather(*(_upload_one(ch) for ch in new_chapters))
    # Strip the in-memory _text field before insert (not a column).
    insert_rows = [{k: v for k, v in ch.items() if k != "_text"} for ch in new_chapters]

    # Clean up any orphaned offset-indexed chapters from a previous failed split
    # attempt. Without this, re-running auto-split hits a unique constraint on
    # (book_id, chapter_index) because those rows were never normalized/deleted.
    try:
        db.table("chapters").delete().eq("book_id", book_id).gte("chapter_index", OFFSET).execute()
    except Exception:
        pass

    # INSERT new rows first. If this fails (e.g. DB timeout) the old chapters
    # are still intact and the book is not left empty. Rows now only carry
    # text_storage_path — the heavy text lives in Storage — so larger batches
    # are safe.
    BATCH_SIZE = 100
    inserted_ids: list[str] = []
    try:
        for i in range(0, len(insert_rows), BATCH_SIZE):
            db.table("chapters").insert(insert_rows[i : i + BATCH_SIZE]).execute()
            inserted_ids.extend(ch["id"] for ch in insert_rows[i : i + BATCH_SIZE])
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

    # Only now that new chapters are safely stored: delete old chapters' audio + text
    chapter_ids = [ch["id"] for ch in chapters]
    for ch in chapters:
        try:
            await storage_service.delete_path("audio", f"{book_id}/{ch['id']}.mp3")
        except Exception:
            pass
        try:
            await storage_service.delete_chapter_text(book_id, ch["id"])
        except Exception:
            pass
    # Delete only the chapters we actually fetched and processed, in batches of
    # 100 to stay within URL length limits (each UUID is ~36 chars).
    DELETE_BATCH = 100
    for i in range(0, len(chapter_ids), DELETE_BATCH):
        db.table("chapters").delete().in_("id", chapter_ids[i : i + DELETE_BATCH]).execute()

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

    import uuid as _uuid
    new_chapter_id = str(_uuid.uuid4())
    text_storage_path = None
    if text_content:
        text_storage_path = await storage_service.upload_chapter_text(
            book_id, new_chapter_id, text_content
        )

    try:
        result = db.table("chapters").insert({
            "id": new_chapter_id,
            "book_id": book_id,
            "chapter_index": body.chapter_index,
            "title": title,
            "text_storage_path": text_storage_path,
            "word_count": word_count,
            "status": "pending",
        }).execute()
    except Exception as e:
        # Clean up the orphaned Storage file before raising
        if text_storage_path:
            try:
                await storage_service.delete_chapter_text(book_id, new_chapter_id)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail="Failed to create chapter")

    # Recalculate total_chapters
    count_result = db.table("chapters").select("id", count="exact").eq("book_id", book_id).execute()
    total = count_result.count or 0
    db.table("books").update({"total_chapters": total}).eq("id", book_id).execute()

    ch = result.data[0]
    return ChapterResponse(**ch, audio=None)
