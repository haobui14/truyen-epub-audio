import logging
from storage3 import SyncStorageClient
from app.config import settings

logger = logging.getLogger(__name__)

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


async def upload_bytes(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    """Upload bytes to Supabase Storage and return public URL."""
    storage = _get_storage()
    storage.from_(bucket).upload(
        path=path,
        file=data,
        file_options={"content-type": content_type, "upsert": "true"},
    )
    url = storage.from_(bucket).get_public_url(path)
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
        _get_storage().from_(bucket).remove([path])
    except Exception as e:
        logger.warning(f"Could not delete {bucket}/{path}: {e}")


async def delete_folder(bucket: str, prefix: str) -> None:
    """Delete all files under a prefix in Supabase Storage."""
    try:
        storage = _get_storage()
        files = storage.from_(bucket).list(prefix)
        if files:
            paths = [f"{prefix}/{f['name']}" for f in files]
            storage.from_(bucket).remove(paths)
    except Exception as e:
        logger.warning(f"Could not delete folder {bucket}/{prefix}: {e}")
