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
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: gTTS(text=text, lang="vi").write_to_fp(buf))
    return buf.getvalue()


MAX_SPEAK_TEXT_LEN = 2000  # chars — well above any single chunk (~600 chars typical)


@router.post("/speak")
async def speak_text(
    text: str = Body(..., embed=True),
    voice: str = Body("vi-VN-HoaiMyNeural", embed=True),
):
    """
    Generate TTS for a short text chunk and stream back audio/mpeg bytes.
    Uses edge-tts (HoaiMy/NamMinh) with gTTS as fallback.
    """
    if not text or not text.strip():
        raise HTTPException(status_code=422, detail="text must not be empty")
    if len(text) > MAX_SPEAK_TEXT_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"text too long ({len(text)} chars, max {MAX_SPEAK_TEXT_LEN})",
        )
    data: bytes
    if voice in EDGE_TTS_VOICES:
        try:
            data = await _speak_edge(text, voice)
        except Exception:
            data = await _speak_gtts(text)
    else:
        data = await _speak_gtts(text)
    return StreamingResponse(io.BytesIO(data), media_type="audio/mpeg")


@router.get("/chapter-audio/{chapter_id}")
async def chapter_full_audio(chapter_id: str, voice: str = "vi-VN-HoaiMyNeural"):
    """
    Return the full chapter as a single MP3 for offline caching.

    Priority:
      1. Pre-generated file already in audio_files table → stream it directly
         (avoids re-generating and is instant).
      2. On-the-fly generation as fallback (edge-tts → gTTS).
    """
    import tempfile, os, httpx

    db = get_client()

    # ── 1. Check for a pre-stored audio file ─────────────────────────────────
    audio_row = (
        db.table("audio_files")
        .select("public_url")
        .eq("chapter_id", chapter_id)
        .maybe_single()
        .execute()
    )
    if audio_row.data and audio_row.data.get("public_url"):
        public_url = audio_row.data["public_url"]
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.get(public_url)
                r.raise_for_status()
                return StreamingResponse(
                    io.BytesIO(r.content),
                    media_type="audio/mpeg",
                    headers={"Cache-Control": "public, max-age=86400"},
                )
        except Exception:
            pass  # fall through to on-the-fly generation

    # ── 2. Fetch chapter text ─────────────────────────────────────────────────
    chapter = (
        db.table("chapters")
        .select("id,text_content")
        .eq("id", chapter_id)
        .single()
        .execute()
    )
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    text = (chapter.data.get("text_content") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Chapter has no text content")

    # ── 3. On-the-fly generation ──────────────────────────────────────────────
    # For edge-tts: chunk the text (edge-tts can stall on very long inputs)
    if voice in EDGE_TTS_VOICES:
        from app.utils.text_cleaner import split_text_for_tts
        chunks = split_text_for_tts(text, max_chars=3000)
        chunk_bytes: list[bytes] = []
        failed = False
        for chunk in chunks:
            try:
                chunk_bytes.append(await _speak_edge(chunk, voice))
            except Exception:
                failed = True
                break
        if not failed and chunk_bytes:
            return StreamingResponse(
                io.BytesIO(b"".join(chunk_bytes)),
                media_type="audio/mpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )
        # fall through to gTTS on any edge-tts failure

    # gTTS path — handles chunking + concat internally
    from app.services.tts_service import generate_audio
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        tmp_path = f.name
    try:
        await generate_audio(text, "gtts", tmp_path)
        with open(tmp_path, "rb") as f:
            data = f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return StreamingResponse(
        io.BytesIO(data),
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


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
