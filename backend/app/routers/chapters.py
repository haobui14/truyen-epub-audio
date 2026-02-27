from fastapi import APIRouter, HTTPException
from app.database import get_client
from app.models.chapter import ChapterResponse, AudioSummary
from app.models.audio import AudioFileResponse

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
