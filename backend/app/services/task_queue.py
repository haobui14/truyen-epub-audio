import asyncio
import os
import tempfile
import uuid
import logging

from app.database import get_client

logger = logging.getLogger(__name__)

_queue: asyncio.Queue = asyncio.Queue()
_worker_task: asyncio.Task | None = None


async def enqueue(book_id: str, chapter_id: str) -> None:
    await _queue.put({"book_id": book_id, "chapter_id": chapter_id})


async def start_worker() -> None:
    global _worker_task
    _worker_task = asyncio.create_task(_process_queue())
    logger.info("TTS queue worker started")


async def _process_queue() -> None:
    while True:
        job = await _queue.get()
        try:
            await _process_chapter(job["book_id"], job["chapter_id"])
        except Exception as e:
            logger.exception(f"Unhandled error in queue worker: {e}")
            _mark_chapter_error(job["chapter_id"], str(e))
        finally:
            _queue.task_done()


async def _process_chapter(book_id: str, chapter_id: str) -> None:
    # Import here to avoid circular imports
    from app.services import tts_service, storage_service

    db = get_client()
    tmp_path = None

    try:
        # Fetch chapter text
        result = db.table("chapters").select("text_content,title,status").eq("id", chapter_id).single().execute()
        chapter = result.data

        if not chapter or chapter.get("status") == "ready":
            return

        if not chapter.get("text_content"):
            _mark_chapter_error(chapter_id, "No text content")
            return

        # Mark as converting
        db.table("chapters").update({"status": "converting"}).eq("id", chapter_id).execute()

        # Get voice from book
        book_result = db.table("books").select("voice").eq("id", book_id).single().execute()
        voice = book_result.data.get("voice", "vi-VN-HoaiMyNeural")

        # Generate audio
        tmp_path = tempfile.mktemp(suffix=".mp3")
        duration = await tts_service.generate_audio(
            text=chapter["text_content"],
            voice=voice,
            output_path=tmp_path,
        )

        # Get file size
        file_size = os.path.getsize(tmp_path)

        # Upload to Supabase Storage
        storage_path = f"audio/{book_id}/{chapter_id}.mp3"
        public_url = await storage_service.upload_file(
            bucket="audio",
            path=storage_path,
            file_path=tmp_path,
            content_type="audio/mpeg",
        )

        # Insert audio_files record
        db.table("audio_files").upsert({
            "id": str(uuid.uuid4()),
            "chapter_id": chapter_id,
            "book_id": book_id,
            "storage_path": storage_path,
            "public_url": public_url,
            "file_size_bytes": file_size,
            "duration_seconds": duration,
            "voice": voice,
        }, on_conflict="chapter_id").execute()

        # Mark chapter ready
        db.table("chapters").update({"status": "ready"}).eq("id", chapter_id).execute()
        logger.info(f"Chapter {chapter_id} converted successfully ({duration:.1f}s)")

        # Check if all chapters for this book are done
        _check_book_complete(book_id)

    except Exception as e:
        logger.exception(f"Error processing chapter {chapter_id}: {e}")
        _mark_chapter_error(chapter_id, str(e))
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _mark_chapter_error(chapter_id: str, message: str) -> None:
    try:
        db = get_client()
        db.table("chapters").update({
            "status": "error",
            "error_message": message[:500],
        }).eq("id", chapter_id).execute()
    except Exception as e:
        logger.error(f"Could not mark chapter {chapter_id} as error: {e}")


def _check_book_complete(book_id: str) -> None:
    try:
        db = get_client()
        result = db.table("chapters").select("status").eq("book_id", book_id).execute()
        chapters = result.data
        if not chapters:
            return
        statuses = {c["status"] for c in chapters}
        pending = {"pending", "converting"}
        if not statuses.intersection(pending):
            # All done (some may be error)
            has_ready = any(c["status"] == "ready" for c in chapters)
            new_status = "ready" if has_ready else "error"
            db.table("books").update({"status": new_status}).eq("id", book_id).execute()
            logger.info(f"Book {book_id} marked as {new_status}")
    except Exception as e:
        logger.error(f"Could not check book completion for {book_id}: {e}")
