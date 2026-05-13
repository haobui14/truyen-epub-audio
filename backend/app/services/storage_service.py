import asyncio
import logging
from storage3 import SyncStorageClient
from app.config import settings

logger = logging.getLogger(__name__)

CHAPTER_TEXT_BUCKET = "chapter-text"

_storage_client: SyncStorageClient | None = None


def _get_storage() -> SyncStorageClient:
    """Return a dedicated storage client that always uses the service key."""
    global _storage_client
    if _storage_client is None:
        headers = {
            "apiKey": settings.supabase_service_key,
            "Authorization": f"Bearer {settings.supabase_service_key}",
        }
        _storage_client = SyncStorageClient(
            f"{settings.supabase_url}/storage/v1", headers
        )
    return _storage_client


# storage3 is a sync SDK — calling it directly from `async def` blocks the
# event loop, so asyncio.gather() over these calls gives zero concurrency.
# Run every storage HTTP call on the default thread pool so gather() actually
# fans out (default pool size is min(32, os.cpu_count()+4), plenty for our
# 20-way upload/download semaphores).

def _sync_upload(bucket: str, path: str, data: bytes, content_type: str) -> None:
    _get_storage().from_(bucket).upload(
        path=path,
        file=data,
        file_options={"content-type": content_type, "upsert": "true"},
    )


def _sync_download(bucket: str, path: str) -> bytes:
    return _get_storage().from_(bucket).download(path)


def _sync_remove(bucket: str, paths: list[str]) -> None:
    _get_storage().from_(bucket).remove(paths)


def _sync_list(bucket: str, prefix: str) -> list[dict]:
    return _get_storage().from_(bucket).list(prefix)


async def upload_bytes(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    """Upload bytes to Supabase Storage and return public URL."""
    await asyncio.to_thread(_sync_upload, bucket, path, data, content_type)
    return _get_storage().from_(bucket).get_public_url(path)


async def upload_file(
    bucket: str,
    path: str,
    file_path: str,
    content_type: str = "audio/mpeg",
) -> str:
    """Upload a local file to Supabase Storage and return public URL."""
    with open(file_path, "rb") as f:
        data = f.read()
    return await upload_bytes(bucket, path, data, content_type)


def chapter_text_path(book_id: str, chapter_id: str) -> str:
    return f"{book_id}/{chapter_id}.txt"


async def upload_chapter_text(book_id: str, chapter_id: str, text: str) -> str:
    path = chapter_text_path(book_id, chapter_id)
    await asyncio.to_thread(
        _sync_upload,
        CHAPTER_TEXT_BUCKET,
        path,
        text.encode("utf-8"),
        "text/plain; charset=utf-8",
    )
    return path


async def download_chapter_text(path: str) -> str:
    data = await asyncio.to_thread(_sync_download, CHAPTER_TEXT_BUCKET, path)
    return data.decode("utf-8")


async def get_chapter_text(chapter_id: str) -> str:
    """Fetch chapter text by ID from Supabase Storage via text_storage_path.
    Returns empty string if no path set or download fails.

    Note: This issues a DB query to resolve text_storage_path. Callers that
    already know book_id should use get_chapter_text_by_ids() to skip it.
    """
    from app.database import get_client
    db = get_client()
    result = (
        db.table("chapters")
        .select("text_storage_path")
        .eq("id", chapter_id)
        .maybe_single()
        .execute()
    )
    if not result.data:
        return ""
    path = result.data.get("text_storage_path")
    if not path:
        return ""
    try:
        return await download_chapter_text(path)
    except Exception as e:
        logger.warning(f"Storage download failed for chapter {chapter_id} ({path}): {e}")
        return ""


async def get_chapter_text_by_ids(book_id: str, chapter_id: str) -> str:
    """Fetch chapter text directly from Storage using the deterministic
    {book_id}/{chapter_id}.txt path — no DB round-trip. Returns "" if missing."""
    path = chapter_text_path(book_id, chapter_id)
    try:
        return await download_chapter_text(path)
    except Exception as e:
        logger.warning(f"Storage download failed for chapter {chapter_id} ({path}): {e}")
        return ""


async def write_chapter_text(book_id: str, chapter_id: str, text: str) -> str:
    """Upload chapter text to Storage and update the row's text_storage_path.
    Returns the storage path."""
    from app.database import get_client
    path = await upload_chapter_text(book_id, chapter_id, text)
    db = get_client()
    db.table("chapters").update({
        "text_storage_path": path,
    }).eq("id", chapter_id).execute()
    return path


async def delete_chapter_text(book_id: str, chapter_id: str) -> None:
    """Best-effort delete of a chapter's text file from Storage."""
    await delete_path(CHAPTER_TEXT_BUCKET, chapter_text_path(book_id, chapter_id))


async def delete_path(bucket: str, path: str) -> None:
    """Delete a file from Supabase Storage."""
    try:
        await asyncio.to_thread(_sync_remove, bucket, [path])
    except Exception as e:
        logger.warning(f"Could not delete {bucket}/{path}: {e}")


async def delete_folder(bucket: str, prefix: str) -> None:
    """Delete all files under a prefix in Supabase Storage."""
    try:
        files = await asyncio.to_thread(_sync_list, bucket, prefix)
        if files:
            paths = [f"{prefix}/{f['name']}" for f in files]
            await asyncio.to_thread(_sync_remove, bucket, paths)
    except Exception as e:
        logger.warning(f"Could not delete folder {bucket}/{prefix}: {e}")
