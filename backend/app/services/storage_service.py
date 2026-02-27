import logging
from app.database import get_client
from app.config import settings

logger = logging.getLogger(__name__)


async def upload_bytes(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    """Upload bytes to Supabase Storage and return public URL."""
    db = get_client()
    db.storage.from_(bucket).upload(
        path=path,
        file=data,
        file_options={"content-type": content_type, "upsert": "true"},
    )
    url = db.storage.from_(bucket).get_public_url(path)
    return url


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


async def delete_path(bucket: str, path: str) -> None:
    """Delete a file from Supabase Storage."""
    try:
        db = get_client()
        db.storage.from_(bucket).remove([path])
    except Exception as e:
        logger.warning(f"Could not delete {bucket}/{path}: {e}")


async def delete_folder(bucket: str, prefix: str) -> None:
    """Delete all files under a prefix in Supabase Storage."""
    try:
        db = get_client()
        files = db.storage.from_(bucket).list(prefix)
        if files:
            paths = [f"{prefix}/{f['name']}" for f in files]
            db.storage.from_(bucket).remove(paths)
    except Exception as e:
        logger.warning(f"Could not delete folder {bucket}/{prefix}: {e}")
