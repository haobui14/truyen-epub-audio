import asyncio
import io
from fastapi import APIRouter, HTTPException, Body
from fastapi.responses import StreamingResponse
from app.database import get_client
from app.services import task_queue

router = APIRouter(prefix="/api/tts", tags=["tts"])


@router.post("/book/{book_id}")
async def enqueue_book_tts(book_id: str):
    db = get_client()
    book = db.table("books").select("id,status").eq("id", book_id).single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")

    chapters = db.table("chapters").select("id,status").eq("book_id", book_id).execute()
    enqueued = 0
    for ch in (chapters.data or []):
        if ch["status"] in ("pending", "error"):
            await task_queue.enqueue(book_id, ch["id"])
            enqueued += 1

    if enqueued > 0:
        db.table("books").update({"status": "converting"}).eq("id", book_id).execute()

    return {"enqueued": enqueued}


@router.post("/chapter/{chapter_id}")
async def enqueue_chapter_tts(chapter_id: str):
    db = get_client()
    chapter = db.table("chapters").select("id,book_id,status").eq("id", chapter_id).single().execute()
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    ch = chapter.data
    await task_queue.enqueue(ch["book_id"], chapter_id)
    db.table("chapters").update({"status": "pending", "error_message": None}).eq("id", chapter_id).execute()
    return {"status": "enqueued"}


@router.post("/prefetch/{book_id}")
async def prefetch_chapters(book_id: str, from_index: int = 0, count: int = 3):
    """
    Enqueue TTS for `count` pending chapters starting at `from_index`.
    Called by the frontend when the user starts playing chapter N to
    pre-generate chapters N+1 … N+count.
    """
    db = get_client()
    chapters = (
        db.table("chapters")
        .select("id,chapter_index,status")
        .eq("book_id", book_id)
        .gte("chapter_index", from_index)
        .lt("chapter_index", from_index + count)
        .order("chapter_index")
        .execute()
    )

    enqueued = 0
    for ch in (chapters.data or []):
        if ch["status"] == "pending":
            await task_queue.enqueue(book_id, ch["id"])
            enqueued += 1

    if enqueued > 0:
        db.table("books").update({"status": "converting"}).eq("id", book_id).execute()

    return {"enqueued": enqueued, "from_index": from_index, "count": count}


EDGE_TTS_VOICES = {"vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"}


async def _speak_edge(text: str, voice: str) -> bytes:
    """Generate audio via edge-tts, return MP3 bytes."""
    import tempfile, os
    import edge_tts
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        tmp = f.name
    try:
        await edge_tts.Communicate(text, voice).save(tmp)
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


async def _speak_gtts(text: str) -> bytes:
    """Generate audio via gTTS, return MP3 bytes."""
    from gtts import gTTS
    buf = io.BytesIO()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: gTTS(text=text, lang="vi").write_to_fp(buf))
    return buf.getvalue()


@router.post("/speak")
async def speak_text(
    text: str = Body(..., embed=True),
    voice: str = Body("vi-VN-HoaiMyNeural", embed=True),
):
    """
    Generate TTS for a short text chunk and stream back audio/mpeg bytes.
    Uses edge-tts (HoaiMy/NamMinh) with gTTS as fallback.
    """
    data: bytes
    if voice in EDGE_TTS_VOICES:
        try:
            data = await _speak_edge(text, voice)
        except Exception:
            data = await _speak_gtts(text)
    else:
        data = await _speak_gtts(text)
    return StreamingResponse(io.BytesIO(data), media_type="audio/mpeg")


@router.get("/status/{book_id}")
async def get_tts_status(book_id: str):
    db = get_client()
    chapters = db.table("chapters").select(
        "id,chapter_index,title,status,error_message"
    ).eq("book_id", book_id).order("chapter_index").execute()

    data = chapters.data or []
    total = len(data)
    ready = sum(1 for c in data if c["status"] == "ready")
    failed = sum(1 for c in data if c["status"] == "error")
    converting = sum(1 for c in data if c["status"] == "converting")
    pending = sum(1 for c in data if c["status"] == "pending")

    return {
        "book_id": book_id,
        "total_chapters": total,
        "ready": ready,
        "failed": failed,
        "converting": converting,
        "pending": pending,
        "chapters": data,
    }
