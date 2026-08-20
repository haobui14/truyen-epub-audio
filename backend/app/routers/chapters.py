import asyncio
import logging

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from typing import Optional
from pydantic import BaseModel
from app.database import get_client
from app.dependencies import get_admin_user, get_approved_user
from app.models.chapter import ChapterResponse, AudioSummary
from app.config import settings
from app.services import storage_service

router = APIRouter(prefix="/api", tags=["chapters"])
logger = logging.getLogger(__name__)


# Read endpoints are sync (`def`) so FastAPI runs them on the worker thread
# pool: the blocking Supabase client would otherwise stall the single uvicorn
# worker's event loop for a full DB round-trip per call.
@router.get("/chapters/{chapter_id}", response_model=ChapterResponse)
def get_chapter(chapter_id: str):
    db = get_client()
    result = db.table("chapters").select(
        "id,book_id,chapter_index,title,word_count,status,error_message,created_at,updated_at,audio_url,audio_duration_seconds,audio_file_size_bytes"
    ).eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    ch = result.data
    audio = AudioSummary(
        audio_url=ch["audio_url"],
        audio_duration_seconds=ch.get("audio_duration_seconds"),
        audio_file_size_bytes=ch.get("audio_file_size_bytes"),
    ) if ch.get("audio_url") else None
    return ChapterResponse(**{k: v for k, v in ch.items() if k in ChapterResponse.model_fields}, audio=audio)


@router.get("/chapters/{chapter_id}/text")
async def get_chapter_text(
    chapter_id: str,
    _user: dict = Depends(get_approved_user),
):
    db = get_client()
    # Hottest endpoint in the app (every chapter open, web and Android).
    # Selecting text_storage_path here lets us download from Storage directly
    # instead of going through storage_service.get_chapter_text, which
    # re-fetched this same row a second time. to_thread keeps the sync
    # client's round-trip off the event loop.
    result = await asyncio.to_thread(
        lambda: db.table("chapters")
        .select("id,text_storage_path,updated_at")
        .eq("id", chapter_id)
        .maybe_single()
        .execute()
    )
    if not result or not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    row = result.data
    # Same contract as before: no stored path or a failed download → "".
    text = ""
    path = row.get("text_storage_path")
    if path:
        try:
            text = await storage_service.download_chapter_text(
                path, row.get("updated_at")
            )
        except Exception as e:
            logger.warning(
                f"Storage download failed for chapter {chapter_id} ({path}): {e}"
            )
    # updated_at lets clients that cache this text offline (Android app)
    # detect an admin edit and refetch instead of serving stale text forever.
    return {
        "id": row["id"],
        "text_content": text,
        "updated_at": row["updated_at"],
    }


@router.get("/audio/{chapter_id}")
def get_audio(
    chapter_id: str,
    _user: dict = Depends(get_approved_user),
):
    db = get_client()
    result = db.table("chapters").select(
        "id,book_id,audio_url,audio_storage_path,audio_duration_seconds,audio_file_size_bytes,created_at"
    ).eq("id", chapter_id).maybe_single().execute()
    if not result.data or not result.data.get("audio_url"):
        raise HTTPException(status_code=404, detail="Audio not ready yet")
    return result.data


class ChapterTextUpdate(BaseModel):
    text_content: str


class ChapterFullUpdate(BaseModel):
    title: Optional[str] = None
    chapter_index: Optional[int] = None
    text_content: Optional[str] = None


@router.patch("/chapters/{chapter_id}")
async def update_chapter(
    chapter_id: str,
    body: ChapterFullUpdate,
    _admin: dict = Depends(get_admin_user),
):
    db = get_client()
    result = db.table("chapters").select("id,book_id,chapter_index").eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    book_id = result.data["book_id"]

    updates: dict = {}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        updates["title"] = t
    if body.chapter_index is not None:
        if body.chapter_index < 0:
            raise HTTPException(status_code=400, detail="chapter_index must be >= 0")
        # The (book_id, chapter_index) unique constraint would turn a collision
        # into an opaque 500 — check first and return an actionable 409.
        if body.chapter_index != result.data["chapter_index"]:
            collision = (
                db.table("chapters")
                .select("id")
                .eq("book_id", book_id)
                .eq("chapter_index", body.chapter_index)
                .neq("id", chapter_id)
                .limit(1)
                .execute()
            )
            if collision.data:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Vị trí {body.chapter_index + 1} đã có chương khác — "
                        "chọn số khác hoặc đổi số chương kia trước"
                    ),
                )
        updates["chapter_index"] = body.chapter_index
    if body.text_content is not None:
        await storage_service.write_chapter_text(book_id, chapter_id, body.text_content)
        updates["word_count"] = len(body.text_content.split())

    if updates:
        db.table("chapters").update(updates).eq("id", chapter_id).execute()

    updated = db.table("chapters").select(
        "id,chapter_index,title,word_count,updated_at"
    ).eq("id", chapter_id).maybe_single().execute()
    return updated.data


@router.patch("/chapters/{chapter_id}/text")
async def update_chapter_text(
    chapter_id: str,
    body: ChapterTextUpdate,
    _admin: dict = Depends(get_admin_user),
):
    db = get_client()
    result = db.table("chapters").select("id,book_id").eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    word_count = len(body.text_content.split())
    await storage_service.write_chapter_text(result.data["book_id"], chapter_id, body.text_content)
    updated = db.table("chapters").update({
        "word_count": word_count,
    }).eq("id", chapter_id).execute()
    # updated_at (bumped by trg_chapters_updated_at) lets the editing client
    # stamp its offline chapter-text cache with the NEW version — without it
    # the device's stale cached copy passes the freshness check and the edit
    # appears to revert.
    row = (updated.data or [{}])[0]
    return {
        "id": chapter_id,
        "word_count": word_count,
        "updated_at": row.get("updated_at"),
    }


@router.delete("/chapters/{chapter_id}")
async def delete_chapter(
    chapter_id: str,
    _admin: dict = Depends(get_admin_user),
):
    from app.services import storage_service

    db = get_client()

    # Fetch the chapter to get book_id and index
    result = db.table("chapters").select("id,book_id,chapter_index").eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    book_id = result.data["book_id"]
    deleted_index = result.data["chapter_index"]

    # Delete audio + text files from storage (best effort)
    await storage_service.delete_path("audio", f"{book_id}/{chapter_id}.mp3")
    await storage_service.delete_chapter_text(book_id, chapter_id)

    # Delete the chapter row
    db.table("chapters").delete().eq("id", chapter_id).execute()

    # Re-index all chapters after the deleted one in a single query
    db.rpc("reindex_chapters_after_delete", {
        "p_book_id": book_id,
        "p_deleted_index": deleted_index,
    }).execute()

    # Update book's total_chapters
    count_result = db.table("chapters").select("id", count="exact").eq("book_id", book_id).execute()
    new_total = count_result.count or 0
    db.table("books").update({"total_chapters": new_total}).eq("id", book_id).execute()

    return {"deleted": chapter_id, "total_chapters": new_total}


class AiFixRequest(BaseModel):
    text: str


@router.post("/chapters/{chapter_id}/ai-fix")
async def ai_fix_chapter(
    chapter_id: str,
    body: AiFixRequest,
    _admin: dict = Depends(get_admin_user),
):
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not configured")
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    from app.services.ai_service import stream_ai_fix
    return StreamingResponse(
        stream_ai_fix(body.text),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


class SplitPart(BaseModel):
    title: str
    text_content: str


class SplitRequest(BaseModel):
    parts: list[SplitPart]


@router.post("/chapters/{chapter_id}/split")
async def split_chapter(
    chapter_id: str,
    body: SplitRequest,
    _admin: dict = Depends(get_admin_user),
):
    import uuid as _uuid

    if len(body.parts) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 parts to split")
    for part in body.parts:
        if not part.title.strip():
            raise HTTPException(status_code=400, detail="Each part must have a non-empty title")

    db = get_client()
    result = db.table("chapters").select("id,book_id,chapter_index").eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    book_id = result.data["book_id"]
    base_index = result.data["chapter_index"]
    num_new = len(body.parts) - 1

    # Shift all chapters after base_index up by num_new to make room for new chapters
    db.rpc("shift_chapters_up_by_n", {
        "p_book_id": book_id,
        "p_insert_index": base_index + 1,
        "p_n": num_new,
    }).execute()

    # Update the existing chapter with parts[0]
    first = body.parts[0]
    first_path = await storage_service.upload_chapter_text(book_id, chapter_id, first.text_content)
    db.table("chapters").update({
        "title": first.title.strip(),
        "text_storage_path": first_path,
        "word_count": len(first.text_content.split()),
        "status": "pending",
    }).eq("id", chapter_id).execute()

    # Insert new chapters for parts[1:]
    new_ids = []
    for i, part in enumerate(body.parts[1:], start=1):
        new_id = str(_uuid.uuid4())
        new_ids.append(new_id)
        path = await storage_service.upload_chapter_text(book_id, new_id, part.text_content)
        db.table("chapters").insert({
            "id": new_id,
            "book_id": book_id,
            "chapter_index": base_index + i,
            "title": part.title.strip(),
            "text_storage_path": path,
            "word_count": len(part.text_content.split()),
            "status": "pending",
        }).execute()

    # Update total_chapters
    count_result = db.table("chapters").select("id", count="exact").eq("book_id", book_id).execute()
    new_total = count_result.count or 0
    db.table("books").update({"total_chapters": new_total}).eq("id", book_id).execute()

    return {"chapter_id": chapter_id, "new_chapter_ids": new_ids, "total_chapters": new_total}


class BulkDeleteRequest(BaseModel):
    chapter_ids: list[str]


@router.post("/chapters/bulk-delete")
async def bulk_delete_chapters(
    body: BulkDeleteRequest,
    _admin: dict = Depends(get_admin_user),
):
    from app.services import storage_service

    if not body.chapter_ids:
        raise HTTPException(status_code=400, detail="No chapter IDs provided")

    db = get_client()

    # Fetch all chapters to get book_id mapping
    result = db.table("chapters").select("id,book_id").in_("id", body.chapter_ids).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="No chapters found")

    chapters = result.data
    book_ids = list({ch["book_id"] for ch in chapters})

    # Delete audio + text files from storage (best effort, parallel).
    # Storage fan-out capped at 8 — see storage_service.STORAGE_CONCURRENCY.
    import asyncio
    del_sem = asyncio.Semaphore(8)

    async def _delete_files(ch: dict) -> None:
        async with del_sem:
            try:
                await storage_service.delete_path("audio", f"{ch['book_id']}/{ch['id']}.mp3")
            except Exception:
                pass
            try:
                await storage_service.delete_chapter_text(ch["book_id"], ch["id"])
            except Exception:
                pass

    await asyncio.gather(*(_delete_files(ch) for ch in chapters))

    # Delete all chapter rows at once
    db.table("chapters").delete().in_("id", body.chapter_ids).execute()

    # Re-index remaining chapters per book with a single SQL function each
    for book_id in book_ids:
        db.rpc("reindex_all_chapters", {"p_book_id": book_id}).execute()

    # Update total_chapters per book
    totals: dict[str, int] = {}
    for book_id in book_ids:
        count_result = db.table("chapters").select("id", count="exact").eq("book_id", book_id).execute()
        totals[book_id] = count_result.count or 0
        db.table("books").update({"total_chapters": totals[book_id]}).eq("id", book_id).execute()

    return {"deleted": len(body.chapter_ids), "book_totals": totals}
