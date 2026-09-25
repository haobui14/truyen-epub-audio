import asyncio
import gzip
import logging
import random
import time
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import (
    ClientError,
    ConnectTimeoutError,
    ConnectionClosedError,
    EndpointConnectionError,
    ReadTimeoutError,
)
from app.config import settings

logger = logging.getLogger(__name__)

CHAPTER_TEXT_BUCKET = "chapter-text"
PUBLIC_BUCKETS = frozenset({"audio", "covers"})

# Concurrency limit for callers fanning synchronous S3 requests through
# asyncio.to_thread(). Eight keeps connection use modest during bulk imports.
STORAGE_CONCURRENCY = 8

_storage_client = None


def _require_r2_config() -> None:
    missing = [
        name
        for name in (
            "r2_endpoint_url",
            "r2_access_key_id",
            "r2_secret_access_key",
            "r2_public_bucket_name",
            "r2_private_bucket_name",
            "r2_public_url",
        )
        if not getattr(settings, name, None)
    ]
    if missing:
        raise RuntimeError(
            "Cloudflare R2 is not configured; missing: " + ", ".join(missing)
        )


def _get_storage():
    """Return the shared boto3 client for Cloudflare R2's S3 API."""
    global _storage_client
    if _storage_client is None:
        _require_r2_config()
        _storage_client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint_url.rstrip("/"),
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                max_pool_connections=STORAGE_CONCURRENCY * 2,
                # Application retries below provide consistent logging/backoff.
                retries={"mode": "standard", "max_attempts": 1},
            ),
        )
    return _storage_client


def _object_key(bucket: str, path: str = "") -> str:
    """Map a former Supabase bucket + path into one physical R2 bucket."""
    bucket = bucket.strip("/")
    path = path.strip("/")
    return f"{bucket}/{path}" if path else f"{bucket}/"


def _physical_bucket(bucket: str) -> str:
    _require_r2_config()
    if bucket in PUBLIC_BUCKETS:
        return settings.r2_public_bucket_name
    return settings.r2_private_bucket_name


def public_url(bucket: str, path: str) -> str:
    """Return the public custom-domain URL for an R2 object."""
    _require_r2_config()
    if bucket not in PUBLIC_BUCKETS:
        raise ValueError(f"Logical bucket {bucket!r} is private and has no public URL")
    return f"{settings.r2_public_url.rstrip('/')}/{quote(_object_key(bucket, path), safe='/')}"


class StorageUploadError(Exception):
    """Raised when R2 returns an error for an object operation."""

    def __init__(self, status: int, body: str, bucket: str, path: str, op: str = "upload"):
        self.status = status
        self.body = body
        self.bucket = bucket
        self.path = path
        snippet = body[:500] + ("…" if len(body) > 500 else "")
        super().__init__(
            f"{op} {bucket}/{path} → HTTP {status}: {snippet}"
        )


def _r2_error(exc: ClientError, bucket: str, path: str, op: str) -> StorageUploadError:
    response = exc.response or {}
    status = int((response.get("ResponseMetadata") or {}).get("HTTPStatusCode") or 500)
    error = response.get("Error") or {}
    body = ": ".join(str(v) for v in (error.get("Code"), error.get("Message")) if v)
    return StorageUploadError(status, body or str(exc), bucket, path, op=op)


# boto3 is synchronous, so async entry points run it in the default thread pool.

_RETRY_MAX_ATTEMPTS = 4
_TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def _is_transient(exc: BaseException) -> bool:
    if isinstance(exc, StorageUploadError):
        return exc.status in _TRANSIENT_HTTP_STATUSES
    if isinstance(
        exc,
        (EndpointConnectionError, ConnectionClosedError, ReadTimeoutError, ConnectTimeoutError),
    ):
        return True
    msg = str(exc).lower()
    return (
        "server disconnected" in msg
        or "connection" in msg and ("reset" in msg or "closed" in msg or "aborted" in msg)
        or "timeout" in msg
        or "timed out" in msg
        or "429" in msg
        or "502" in msg
        or "503" in msg
        or "504" in msg
    )


def _retry_sync(fn, *args, what: str = "storage op", **kwargs):
    last_err: BaseException | None = None
    for attempt in range(_RETRY_MAX_ATTEMPTS):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last_err = e
            if attempt == _RETRY_MAX_ATTEMPTS - 1 or not _is_transient(e):
                raise
            sleep = (2 ** attempt) + random.uniform(0, 0.5)
            logger.warning(
                f"{what} attempt {attempt + 1}/{_RETRY_MAX_ATTEMPTS} failed "
                f"({type(e).__name__}: {e}); retrying in {sleep:.1f}s"
            )
            time.sleep(sleep)
    assert last_err is not None
    raise last_err


# ── Chapter-text gzip (de)compression ─────────────────────────────────────────
# Chapter text is stored gzip-compressed (~3x smaller) with Content-Type
# "application/gzip" and no Content-Encoding header, so R2 returns raw bytes.
# Detection is by magic bytes so legacy plain-UTF-8 objects (uploaded before
# compression was added) keep reading correctly forever.

def _is_gzip(data: bytes) -> bool:
    """True if data starts with the gzip magic number (1f 8b). No valid UTF-8
    text starts with 0x1f, so this reliably distinguishes compressed bytes from
    legacy plain-text objects."""
    return len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B


def _gzip_compress(data: bytes) -> bytes:
    # Level 6: level 9 measured no better (2.87x vs 2.86x) on this prose, for
    # more CPU. Empty input still produces a valid (~20-byte) gzip stream.
    return gzip.compress(data, compresslevel=6)


def _gunzip_decompress(data: bytes) -> bytes:
    # Intentionally does NOT catch errors — a corrupt blob must raise so the
    # get_chapter_text* callers (which swallow exceptions → "") return empty
    # rather than feeding garbage to the reader / TTS engine.
    return gzip.decompress(data)


def _sync_upload(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str,
    cache_control: str | None = None,
) -> None:
    def _do() -> None:
        kwargs = {
            "Bucket": _physical_bucket(bucket),
            "Key": _object_key(bucket, path),
            "Body": data,
            "ContentType": content_type,
        }
        effective_cache_control = cache_control
        if effective_cache_control is None and bucket in PUBLIC_BUCKETS:
            # Public object paths are content-addressed in practice; cover
            # replacements append a new ?v= URL in the database.
            effective_cache_control = "public, max-age=31536000, immutable"
        if effective_cache_control:
            kwargs["CacheControl"] = effective_cache_control
        try:
            _get_storage().put_object(**kwargs)
        except ClientError as exc:
            raise _r2_error(exc, bucket, path, "upload") from exc
    _retry_sync(_do, what=f"upload {bucket}/{path}")


def _sync_download(bucket: str, path: str, version: str | None = None) -> bytes:
    """Download an object from R2. `version` remains API-compatible but is not
    needed because backend reads use the authenticated S3 endpoint, not CDN."""
    def _do() -> bytes:
        try:
            response = _get_storage().get_object(
                Bucket=_physical_bucket(bucket),
                Key=_object_key(bucket, path),
            )
            return response["Body"].read()
        except ClientError as exc:
            raise _r2_error(exc, bucket, path, "download") from exc
    return _retry_sync(_do, what=f"download {bucket}/{path}")


def _sync_remove(bucket: str, paths: list[str]) -> None:
    for start in range(0, len(paths), 1000):
        batch = paths[start:start + 1000]

        def _do(items: list[str] = batch) -> None:
            try:
                response = _get_storage().delete_objects(
                    Bucket=_physical_bucket(bucket),
                    Delete={
                        "Objects": [{"Key": _object_key(bucket, path)} for path in items],
                        "Quiet": True,
                    },
                )
            except ClientError as exc:
                raise _r2_error(exc, bucket, items[0] if items else "", "delete") from exc
            errors = response.get("Errors") or []
            if errors:
                first = errors[0]
                raise StorageUploadError(
                    500,
                    f"{first.get('Code')}: {first.get('Message')}",
                    bucket,
                    first.get("Key") or items[0],
                    op="delete",
                )

        _retry_sync(_do, what=f"remove {bucket} ({len(batch)} files)")


def _sync_list(bucket: str, prefix: str, *, limit: int = 1000, offset: int = 0) -> list[dict]:
    """List one logical directory and emulate Supabase Storage's result shape."""
    base = _object_key(bucket, prefix).rstrip("/") + "/"

    def _do() -> list[dict]:
        entries: list[dict] = []
        token: str | None = None
        wanted = offset + limit
        while len(entries) < wanted:
            kwargs = {
                "Bucket": _physical_bucket(bucket),
                "Prefix": base,
                "Delimiter": "/",
                "MaxKeys": min(1000, max(1, wanted - len(entries))),
            }
            if token:
                kwargs["ContinuationToken"] = token
            try:
                response = _get_storage().list_objects_v2(**kwargs)
            except ClientError as exc:
                raise _r2_error(exc, bucket, prefix, "list") from exc

            page: list[dict] = []
            for folder in response.get("CommonPrefixes") or []:
                name = folder["Prefix"][len(base):].rstrip("/")
                if name:
                    page.append({"name": name, "id": None, "metadata": None})
            for obj in response.get("Contents") or []:
                key = obj["Key"]
                if key == base:  # ignore an optional directory marker
                    continue
                name = key[len(base):]
                if name and "/" not in name:
                    page.append({
                        "name": name,
                        "id": (obj.get("ETag") or key).strip('"'),
                        "metadata": {"size": obj.get("Size") or 0},
                    })
            entries.extend(sorted(page, key=lambda item: item["name"]))
            if not response.get("IsTruncated"):
                break
            token = response.get("NextContinuationToken")
            if not token:
                break
        return entries[offset:wanted]

    return _retry_sync(_do, what=f"list {bucket}/{prefix}")


async def upload_bytes(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    """Upload bytes to R2 and return the public custom-domain URL."""
    await asyncio.to_thread(_sync_upload, bucket, path, data, content_type)
    if bucket in PUBLIC_BUCKETS:
        return public_url(bucket, path)
    return f"r2://{_physical_bucket(bucket)}/{_object_key(bucket, path)}"


async def upload_file(
    bucket: str,
    path: str,
    file_path: str,
    content_type: str = "audio/mpeg",
) -> str:
    """Upload a local file to R2 and return its public URL."""
    with open(file_path, "rb") as f:
        data = f.read()
    return await upload_bytes(bucket, path, data, content_type)


def chapter_text_path(book_id: str, chapter_id: str) -> str:
    return f"{book_id}/{chapter_id}.txt"


async def upload_chapter_text(book_id: str, chapter_id: str, text: str) -> str:
    path = chapter_text_path(book_id, chapter_id)
    # Store gzip-compressed (~3x smaller). Content-Type application/gzip, never
    # Content-Encoding (see the gzip helpers above). download_chapter_text reverses it.
    data = _gzip_compress(text.encode("utf-8"))
    await asyncio.to_thread(
        _sync_upload,
        CHAPTER_TEXT_BUCKET,
        path,
        data,
        "application/gzip",
        "no-cache",
    )
    return path


async def download_chapter_text(path: str, version: str | None = None) -> str:
    """Download and decode a gzip or legacy plain-text chapter object."""
    data = await asyncio.to_thread(_sync_download, CHAPTER_TEXT_BUCKET, path, version)
    # New objects are gzip (magic 1f 8b); legacy objects are plain UTF-8 and skip
    # the gunzip branch — byte-identical to the pre-compression behaviour.
    if _is_gzip(data):
        data = _gunzip_decompress(data)
    return data.decode("utf-8")


async def get_chapter_text(chapter_id: str) -> str:
    """Fetch chapter text by ID from R2 via text_storage_path.
    Returns empty string if no path set or download fails.

    Note: This issues a DB query to resolve text_storage_path. Callers that
    already know book_id should use get_chapter_text_by_ids() to skip it.
    """
    from app.database import get_client
    db = get_client()
    result = (
        db.table("chapters")
        .select("text_storage_path,updated_at")
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
        return await download_chapter_text(path, result.data.get("updated_at"))
    except Exception as e:
        logger.warning(f"Storage download failed for chapter {chapter_id} ({path}): {e}")
        return ""


async def get_chapter_text_by_ids(
    book_id: str, chapter_id: str, version: str | None = None
) -> str:
    """Fetch chapter text directly from Storage using the deterministic
    {book_id}/{chapter_id}.txt path — no DB round-trip. Returns "" if missing.
    Pass the row's updated_at as `version` when available (CDN cache-bust)."""
    path = chapter_text_path(book_id, chapter_id)
    try:
        return await download_chapter_text(path, version)
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
    """Delete a file from R2."""
    try:
        await asyncio.to_thread(_sync_remove, bucket, [path])
    except Exception as e:
        logger.warning(f"Could not delete {bucket}/{path}: {e}")


async def delete_folder(bucket: str, prefix: str) -> None:
    """Delete every file immediately under a logical R2 prefix."""
    PAGE = 1000
    try:
        while True:
            # Always list from offset 0: as we remove files they drop out of
            # the result set, so the next "page" is still at the start.
            files = await asyncio.to_thread(_sync_list, bucket, prefix, limit=PAGE)
            if not files:
                return
            paths = [f"{prefix}/{f['name']}" for f in files]
            await asyncio.to_thread(_sync_remove, bucket, paths)
            if len(files) < PAGE:
                return
    except Exception as e:
        logger.warning(f"Could not delete folder {bucket}/{prefix}: {e}")
