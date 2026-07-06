import logging

from fastapi import APIRouter, HTTPException, Query, Depends, UploadFile, File, Form
from typing import List, Optional
from pydantic import BaseModel

from app.config import settings
from app.database import get_client
from app.dependencies import get_admin_user
from app.models.book import BookResponse
from app.models.chapter import ChapterResponse, AudioSummary, PaginatedChaptersResponse
from app.services import storage_service

router = APIRouter(prefix="/api/books", tags=["books"])
logger = logging.getLogger(__name__)


def _attach_genres(rows: list) -> list:
    """Flatten nested book_genres → genres into a top-level list."""
    out = []
    for row in rows:
        raw_bg = row.pop("book_genres", []) or []
        genres = [bg["genres"] for bg in raw_bg if bg.get("genres")]
        out.append({**row, "genres": genres})
    return out


_BOOK_SELECT = (
    "id,title,author,description,cover_url,voice,status,error_message,total_chapters,created_at,"
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
    import asyncio
    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Delete from storage (best effort, all four buckets in parallel).
    await asyncio.gather(
        storage_service.delete_folder("audio", book_id),
        storage_service.delete_folder("covers", book_id),
        storage_service.delete_folder("epub-uploads", book_id),
        storage_service.delete_folder("chapter-text", book_id),
    )

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
    # Keep storage fan-out low — see storage_service.STORAGE_CONCURRENCY note.
    CONCURRENCY = 8
    sem = asyncio.Semaphore(CONCURRENCY)
    target = body.target
    updated_count = 0

    async def _strip_one(ch: dict) -> bool:
        async with sem:
            text = await storage_service.get_chapter_text_by_ids(book_id, ch["id"])
            if target not in text:
                return False
            new_text = text.replace(target, "")
            new_word_count = len(new_text.split()) if new_text.strip() else 0
            await storage_service.write_chapter_text(book_id, ch["id"], new_text)
            await asyncio.to_thread(
                lambda: db.table("chapters").update({
                    "word_count": new_word_count,
                }).eq("id", ch["id"]).execute()
            )
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


@router.post("/{book_id}/reparse")
async def reparse_book(
    book_id: str,
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: re-run the EPUB parser against the original file stored in
    the epub-uploads bucket. Use this after a parser fix when re-uploading
    isn't practical (e.g. large book). Wipes existing chapters + audio first.

    Returns immediately; parsing runs in the background. Poll the book's
    status field to watch progress (parsing → parsed → converting)."""
    import asyncio
    from app.services import epub_parser

    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    # Locate the original upload. We don't store the ext on the book row, so
    # list the folder and pick the first file (uploads only ever write one).
    files = await asyncio.to_thread(
        storage_service._sync_list, "epub-uploads", book_id
    )
    if not files:
        raise HTTPException(
            status_code=400,
            detail="No original file in epub-uploads bucket — re-upload required",
        )
    original_name = files[0]["name"]
    ext = "." + original_name.rsplit(".", 1)[-1].lower()

    async def _run() -> None:
        from app.routers.upload import _convert_and_parse
        try:
            raw = await asyncio.to_thread(
                storage_service._sync_download,
                "epub-uploads",
                f"{book_id}/{original_name}",
            )
            # Clear stale state before re-parsing: chapter rows + their storage
            # objects. parse_epub_task uses INSERT (not UPSERT) and would
            # collide on the (book_id, chapter_index) unique constraint.
            await storage_service.delete_folder("chapter-text", book_id)
            await storage_service.delete_folder("audio", book_id)
            db.table("chapters").delete().eq("book_id", book_id).execute()
            db.table("books").update(
                {"status": "parsing", "total_chapters": 0, "error_message": None}
            ).eq("id", book_id).execute()
            # Re-use the upload converter so non-EPUB originals (PDF/TXT/MOBI)
            # still work after re-upload to epub-uploads.
            title = original_name.rsplit(".", 1)[0]
            await _convert_and_parse(book_id, raw, ext, title)
        except Exception as e:
            import logging
            logging.getLogger(__name__).exception(
                f"Reparse failed for book {book_id}: {e}"
            )
            db.table("books").update({
                "status": "error",
                "error_message": f"Phân tích lại thất bại: {type(e).__name__}: {e}"[:1000],
            }).eq("id", book_id).execute()

    asyncio.create_task(_run())
    return {"book_id": book_id, "status": "parsing", "source": original_name}


def _normalize_title(t: Optional[str]) -> str:
    """Whitespace-collapsed, lowercased title for alignment/dedupe compares."""
    return " ".join((t or "").split()).lower()


@router.post("/{book_id}/append-chapters")
async def append_chapters_from_file(
    book_id: str,
    file: UploadFile = File(...),
    mode: str = Form("auto"),
    _admin: dict = Depends(get_admin_user),
):
    """Admin-only: update an ONGOING book with new chapters from a re-downloaded
    file (EPUB/TXT/PDF/PRC/MOBI) — the webnovel "story got 200 more chapters"
    flow. Existing chapter rows are never touched, so chapter ids, reading
    progress, and XP all survive (unlike /reparse, which wipes and re-creates
    every chapter with new ids).

    mode="auto" (default): the file is a full bundle of the book. The parsed
    chapter list is aligned to the existing chapters — anchored on the LAST
    existing chapter's title, falling back to position when titles changed —
    and only the tail beyond the anchor is appended.

    mode="all": the file contains ONLY new chapters; everything parsed is
    appended. In both modes, chapters whose exact (normalized) title already
    exists in the book are skipped as duplicates and reported.

    Runs synchronously through parse + row insert (seconds); the bulk of the
    chapter-text Storage uploads continue in the background exactly like the
    initial upload flow, so new chapters are browsable immediately."""
    import asyncio
    import uuid as _uuid

    from app.routers.upload import (
        ORIG_CONTENT_TYPES,
        VALID_EXTENSIONS,
        _to_epub_bytes,
        _validate_upload_shape,
    )
    from app.services import epub_parser

    if mode not in ("auto", "all"):
        raise HTTPException(status_code=400, detail="mode must be 'auto' or 'all'")

    db = get_client()
    book = db.table("books").select("id,status").eq("id", book_id).maybe_single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")
    if book.data.get("status") == "parsing":
        raise HTTPException(
            status_code=409,
            detail="Truyện đang được phân tích — đợi xong rồi thử lại",
        )

    # ── Validate the file exactly like the initial upload ──────────────────
    filename = file.filename or ""
    ext = next((e for e in VALID_EXTENSIONS if filename.lower().endswith(e)), None)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail="Only .epub, .pdf, .txt, .prc, and .mobi files are accepted",
        )
    content = await file.read()
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max {settings.max_upload_size_mb}MB",
        )
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    _validate_upload_shape(content, ext)

    # ── Existing chapters, in reading order (paginated past the PostgREST
    # max_rows cap — same pattern as auto-split) ────────────────────────────
    PAGE_SIZE = 500
    existing: list[dict] = []
    fetch_offset = 0
    while True:
        page = db.table("chapters").select(
            "id,chapter_index,title"
        ).eq("book_id", book_id).order("chapter_index").range(
            fetch_offset, fetch_offset + PAGE_SIZE - 1
        ).execute()
        batch = page.data or []
        existing.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        fetch_offset += PAGE_SIZE

    # ── Convert + parse the uploaded file (CPU on worker threads) ───────────
    title_guess = filename[: -len(ext)]
    try:
        epub_bytes = await _to_epub_bytes(content, ext, title_guess)
        extracted = await asyncio.to_thread(
            epub_parser.extract_epub_contents, epub_bytes, book_id
        )
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Không tìm thấy chương nào có thể đọc trong file ({e})",
        )
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Không đọc được file: {type(e).__name__}: {e}",
        )
    parsed = extracted["chapters"]

    # ── Alignment: which parsed chapters are NEW? ───────────────────────────
    existing_titles = {_normalize_title(ch["title"]) for ch in existing}
    if mode == "auto" and existing:
        # Anchor on the LAST existing chapter's title, scanning the parsed list
        # from the end (a full bundle contains it near its tail). Fall back to
        # position when titles shifted (e.g. re-crawled source renamed them).
        last_title = _normalize_title(existing[-1]["title"])
        anchor_pos = None
        for i in range(len(parsed) - 1, -1, -1):
            if _normalize_title(parsed[i]["title"]) == last_title:
                anchor_pos = i
                break
        if anchor_pos is not None:
            candidates = parsed[anchor_pos + 1:]
        elif len(parsed) > len(existing):
            candidates = parsed[len(existing):]
        else:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Không xác định được phần mới: file có {len(parsed)} chương, "
                    f"truyện đang có {len(existing)} chương và tiêu đề chương cuối "
                    "không khớp. Nếu file chỉ chứa các chương mới, chọn chế độ "
                    "'File chỉ chứa chương mới'."
                ),
            )
    else:
        # mode == "all", or the book has no chapters yet — take everything.
        candidates = parsed

    # Never re-add a chapter whose exact title already exists. Protects against
    # slight positional misalignment and against re-uploading the same partial
    # file twice. Books with legitimately duplicated titles will see them in
    # skipped_duplicates — surfaced to the admin rather than silently dropped.
    new_chapters = [
        c for c in candidates if _normalize_title(c["title"]) not in existing_titles
    ]
    skipped = len(candidates) - len(new_chapters)

    if not new_chapters:
        return {
            "existing_chapters": len(existing),
            "parsed_chapters": len(parsed),
            "appended": 0,
            "skipped_duplicates": skipped,
            "new_total": len(existing),
            "replaced_original": False,
        }

    # ── Build new rows continuing the existing index sequence ───────────────
    next_index = (existing[-1]["chapter_index"] + 1) if existing else 0
    rows: list[dict] = []
    for i, ch in enumerate(new_chapters):
        cid = str(_uuid.uuid4())
        rows.append({
            "id": cid,
            "book_id": book_id,
            "chapter_index": next_index + i,
            "title": ch["title"],
            "text_content": ch["text_content"],
            "word_count": ch["word_count"],
            "status": "pending",
            "text_storage_path": storage_service.chapter_text_path(book_id, cid),
        })

    # Same instant-availability pattern as the initial parse: the first few
    # texts upload synchronously (readable the moment we return), the rest fill
    # in via the shared deferred background uploader after rows are inserted.
    PREFETCH_AHEAD = 3
    prefetch, deferred = rows[:PREFETCH_AHEAD], rows[PREFETCH_AHEAD:]
    prefetch_ok = 0
    for ch in prefetch:
        try:
            await storage_service.upload_chapter_text(
                book_id, ch["id"], ch["text_content"]
            )
            prefetch_ok += 1
        except Exception as e:
            logger.exception(
                f"Book {book_id}: append prefetch text upload failed for "
                f"chapter {ch['id']} ({ch.get('title')!r})"
            )
            ch["status"] = "error"
            ch["error_message"] = f"{type(e).__name__}: {e}"[:1000]
    if prefetch and prefetch_ok == 0:
        raise HTTPException(
            status_code=502,
            detail="Không tải được nội dung chương lên Storage — thử lại sau",
        )

    # INSERT in batches; roll back inserted rows on failure so the book is
    # never left with a partial tail.
    BATCH_SIZE = 100
    insert_rows = [
        {k: v for k, v in ch.items() if k != "text_content"} for ch in rows
    ]
    inserted_ids: list[str] = []
    try:
        for i in range(0, len(insert_rows), BATCH_SIZE):
            db.table("chapters").insert(insert_rows[i:i + BATCH_SIZE]).execute()
            inserted_ids.extend(r["id"] for r in insert_rows[i:i + BATCH_SIZE])
    except Exception as insert_err:
        for i in range(0, len(inserted_ids), BATCH_SIZE):
            try:
                db.table("chapters").delete().in_(
                    "id", inserted_ids[i:i + BATCH_SIZE]
                ).execute()
            except Exception:
                pass
        raise HTTPException(
            status_code=500,
            detail=f"Thêm chương thất bại (chương cũ không bị ảnh hưởng): {insert_err}",
        )

    new_total = len(existing) + len(rows)
    book_updates: dict = {"total_chapters": new_total}
    # A previously-errored book that just gained readable chapters is usable
    # again — clear the error state.
    if book.data.get("status") == "error":
        book_updates["status"] = "ready"
        book_updates["error_message"] = None
    db.table("books").update(book_updates).eq("id", book_id).execute()

    if deferred:
        bg = asyncio.create_task(
            epub_parser._upload_deferred_chapter_text(book_id, deferred)
        )
        epub_parser._deferred_text_tasks.add(bg)
        bg.add_done_callback(epub_parser._deferred_text_tasks.discard)

    # If the file covers the whole book (full bundle), replace the stored
    # original so a future /reparse works from the newest version. Partial
    # files (mode=all) leave the original untouched. Best effort — the append
    # itself already succeeded.
    replaced_original = False
    if len(parsed) >= new_total:
        try:
            await storage_service.delete_folder("epub-uploads", book_id)
            await storage_service.upload_bytes(
                bucket="epub-uploads",
                path=f"{book_id}/original{ext}",
                data=content,
                content_type=ORIG_CONTENT_TYPES[ext],
            )
            replaced_original = True
        except Exception as e:
            logger.warning(
                f"Book {book_id}: could not replace original after append: {e}"
            )

    logger.info(
        f"Book {book_id}: appended {len(rows)} chapters from {filename} "
        f"(parsed={len(parsed)}, skipped_dupes={skipped}, mode={mode}, "
        f"replaced_original={replaced_original})"
    )
    return {
        "existing_chapters": len(existing),
        "parsed_chapters": len(parsed),
        "appended": len(rows),
        "skipped_duplicates": skipped,
        "new_total": new_total,
        "replaced_original": replaced_original,
    }


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
    # See storage_service.STORAGE_CONCURRENCY for why this is capped low.
    DOWNLOAD_CONCURRENCY = 8
    dl_sem = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)

    async def _fetch_text(ch: dict) -> str:
        async with dl_sem:
            return await storage_service.get_chapter_text_by_ids(book_id, ch["id"])

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
    up_sem = asyncio.Semaphore(8)

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

    # Only now that new chapters are safely stored: delete old chapters' audio + text.
    # Fan out per-chapter deletes — best effort, capped concurrency.
    chapter_ids = [ch["id"] for ch in chapters]
    del_sem = asyncio.Semaphore(8)

    async def _delete_old(ch: dict) -> None:
        async with del_sem:
            try:
                await storage_service.delete_path("audio", f"{book_id}/{ch['id']}.mp3")
            except Exception:
                pass
            try:
                await storage_service.delete_chapter_text(book_id, ch["id"])
            except Exception:
                pass

    await asyncio.gather(*(_delete_old(ch) for ch in chapters))
    # Delete only the chapters we actually fetched and processed, in batches of
    # 100 to stay within URL length limits (each UUID is ~36 chars).
    DELETE_BATCH = 100
    for i in range(0, len(chapter_ids), DELETE_BATCH):
        db.table("chapters").delete().in_("id", chapter_ids[i : i + DELETE_BATCH]).execute()

    # Normalize chapter_index back to 0-based now that old rows are gone.
    # Prefer the single-statement RPC (normalize_chapter_offset); if it's not
    # deployed yet (older schema), fall back to parallel per-row updates.
    try:
        await asyncio.to_thread(
            lambda: db.rpc("normalize_chapter_offset", {
                "p_book_id": book_id,
                "p_offset": OFFSET,
            }).execute()
        )
    except Exception as rpc_err:
        # Fallback: N parallel UPDATEs via thread pool.
        norm_sem = asyncio.Semaphore(20)

        async def _renumber_one(ch: dict) -> None:
            real_index = ch["chapter_index"] - OFFSET
            async with norm_sem:
                await asyncio.to_thread(
                    lambda: db.table("chapters").update(
                        {"chapter_index": real_index}
                    ).eq("id", ch["id"]).execute()
                )

        await asyncio.gather(*(_renumber_one(ch) for ch in new_chapters))

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
