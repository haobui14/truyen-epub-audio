from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from typing import Optional
from pydantic import BaseModel
from app.database import get_client
from app.dependencies import get_admin_user
from app.models.chapter import ChapterResponse, AudioSummary
from app.models.audio import AudioFileResponse
from app.config import settings

router = APIRouter(prefix="/api", tags=["chapters"])


@router.get("/chapters/{chapter_id}", response_model=ChapterResponse)
async def get_chapter(chapter_id: str):
    db = get_client()
    result = db.table("chapters").select(
        "id,book_id,chapter_index,title,word_count,status,error_message,created_at"
    ).eq("id", chapter_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    ch = result.data
    audio_result = db.table("audio_files").select(
        "chapter_id,public_url,duration_seconds,file_size_bytes"
    ).eq("chapter_id", chapter_id).maybe_single().execute()

    audio = audio_result.data if audio_result else None
    return ChapterResponse(
        **ch,
        audio=AudioSummary(**audio) if audio else None,
    )


@router.get("/chapters/{chapter_id}/text")
async def get_chapter_text(chapter_id: str):
    db = get_client()
    result = db.table("chapters").select("id,text_content").eq("id", chapter_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    return {"id": result.data["id"], "text_content": result.data.get("text_content") or ""}


@router.get("/audio/{chapter_id}", response_model=AudioFileResponse)
async def get_audio(chapter_id: str):
    db = get_client()
    result = db.table("audio_files").select("*").eq("chapter_id", chapter_id).single().execute()
    if not result.data:
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
    result = db.table("chapters").select("id").eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    updates: dict = {}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        updates["title"] = t
    if body.chapter_index is not None:
        if body.chapter_index < 0:
            raise HTTPException(status_code=400, detail="chapter_index must be >= 0")
        updates["chapter_index"] = body.chapter_index
    if body.text_content is not None:
        updates["text_content"] = body.text_content
        updates["word_count"] = len(body.text_content.split())

    if updates:
        db.table("chapters").update(updates).eq("id", chapter_id).execute()

    updated = db.table("chapters").select(
        "id,chapter_index,title,word_count"
    ).eq("id", chapter_id).single().execute()
    return updated.data


@router.patch("/chapters/{chapter_id}/text")
async def update_chapter_text(
    chapter_id: str,
    body: ChapterTextUpdate,
    _admin: dict = Depends(get_admin_user),
):
    db = get_client()
    result = db.table("chapters").select("id").eq("id", chapter_id).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    word_count = len(body.text_content.split())
    db.table("chapters").update({
        "text_content": body.text_content,
        "word_count": word_count,
    }).eq("id", chapter_id).execute()
    return {"id": chapter_id, "word_count": word_count}


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

    # Delete audio file from storage (best effort)
    await storage_service.delete_path("audio", f"{book_id}/{chapter_id}.mp3")

    # Delete the chapter row (cascades to audio_files)
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

    # Delete audio files from storage (best effort)
    for ch in chapters:
        try:
            await storage_service.delete_path("audio", f"{ch['book_id']}/{ch['id']}.mp3")
        except Exception:
            pass

    # Delete all chapter rows at once (cascades to audio_files)
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
