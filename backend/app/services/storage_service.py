import asyncio
import gzip
import logging
import random
import time
import httpx
from storage3 import SyncStorageClient
from app.config import settings

logger = logging.getLogger(__name__)

CHAPTER_TEXT_BUCKET = "chapter-text"

# Concurrency limit for any caller fanning storage requests through gather().
# Higher values overwhelm storage3's shared HTTP/2 connection and Supabase
# starts closing streams; 8 matches the value the bulk-migration script
# proved stable for this workload.
STORAGE_CONCURRENCY = 8

_storage_client: SyncStorageClient | None = None
_upload_client: httpx.Client | None = None


def _get_storage() -> SyncStorageClient:
    """Return a dedicated storage client that always uses the service key."""
    global _storage_client
    if _storage_client is None:
        headers = {
            "apiKey": settings.supabase_service_key,
            "Authorization": f"Bearer {settings.supabase_service_key}",
        }
        # Trailing slash required by storage3 >= 0.9 (it warns and auto-corrects
        # otherwise, once per boot).
        _storage_client = SyncStorageClient(
            f"{settings.supabase_url}/storage/v1/", headers
        )
    return _storage_client


def _get_direct_client() -> httpx.Client:
    """Direct httpx client for uploads and chapter-text downloads. We bypass
    storage3's upload path because its error handler calls `response.json()`
    on non-2xx bodies and re-raises a bare `StorageException({'statusCode': N})`
    when the body isn't JSON — Supabase's actual error message (e.g.
    "Duplicate", "Payload too large") is discarded. Downloads go direct so we
    can append a cache-busting query param (see _sync_download). Talking to
    /storage/v1 directly lets us surface the response body in the exception.

    HTTP/1.1 (NOT HTTP/2): under our 8-way concurrent upload load, Supabase
    Storage occasionally drops the connection. With HTTP/2 every concurrent
    upload is multiplexed onto a single TCP connection, so one drop kills
    every in-flight stream simultaneously (bursts of 8 RemoteProtocolError
    warnings per disconnect). HTTP/1.1 gives each upload its own TCP socket,
    so a server-side drop only impacts one request."""
    global _upload_client
    if _upload_client is None:
        _upload_client = httpx.Client(
            base_url=f"{settings.supabase_url}/storage/v1",
            headers={
                "apiKey": settings.supabase_service_key,
                "Authorization": f"Bearer {settings.supabase_service_key}",
            },
            timeout=60.0,
            http2=False,
            limits=httpx.Limits(
                max_connections=STORAGE_CONCURRENCY * 2,
                max_keepalive_connections=STORAGE_CONCURRENCY * 2,
            ),
        )
    return _upload_client


class StorageUploadError(Exception):
    """Raised when Supabase Storage returns a non-2xx on upload/download.
    Carries the status code and the raw response body so logs name the
    actual problem."""

    def __init__(self, status: int, body: str, bucket: str, path: str, op: str = "upload"):
        self.status = status
        self.body = body
        self.bucket = bucket
        self.path = path
        snippet = body[:500] + ("…" if len(body) > 500 else "")
        super().__init__(
            f"{op} {bucket}/{path} → HTTP {status}: {snippet}"
        )


# storage3 is a sync SDK — calling it directly from `async def` blocks the
# event loop, so asyncio.gather() over these calls gives zero concurrency.
# Run every storage HTTP call on the default thread pool so gather() actually
# fans out.
#
# Under load Supabase intermittently closes the HTTP/2 stream
# (httpcore.RemoteProtocolError: Server disconnected). storage3 has a bug
# where its error handler in _request references an unbound `response`
# variable in that case, masking the real error as
# `UnboundLocalError: cannot access local variable 'response'`. Treat that
# UnboundLocalError as a transient network failure and retry with backoff.

_RETRY_MAX_ATTEMPTS = 4
_TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def _is_transient(exc: BaseException) -> bool:
    if isinstance(exc, StorageUploadError):
        return exc.status in _TRANSIENT_HTTP_STATUSES
    # httpx network/transport errors (connect, read, write, protocol) — but
    # NOT HTTPStatusError, which we never raise here anyway.
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, UnboundLocalError):
        return "response" in str(exc)
    msg = str(exc).lower()
    return (
        "server disconnected" in msg
        or "remoteprotocolerror" in msg
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
# Chapter text is stored gzip-compressed (~3x smaller) but with Content-Type
# "application/gzip" and NO Content-Encoding header — storage3/httpx would
# auto-decompress a Content-Encoding: gzip response, defeating app-level control.
# So Supabase serves the raw gzip bytes back and we (de)compress explicitly.
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
        headers = {
            "Content-Type": content_type,
            "x-upsert": "true",
        }
        if cache_control:
            # Stored verbatim as the object's cacheControl metadata and served
            # back on downloads — "no-cache" makes Supabase's CDN revalidate
            # instead of serving a stale copy after an upsert.
            headers["Cache-Control"] = cache_control
        resp = _get_direct_client().post(
            f"/object/{bucket}/{path}",
            content=data,
            headers=headers,
        )
        if resp.status_code >= 400:
            raise StorageUploadError(resp.status_code, resp.text, bucket, path)
    _retry_sync(_do, what=f"upload {bucket}/{path}")


def _sync_download(bucket: str, path: str, version: str | None = None) -> bytes:
    """GET an object directly. Supabase serves storage downloads through its
    CDN, which caches per-URL and does NOT invalidate on upsert — after an
    admin edit the old chapter text kept being served from the CDN until its
    TTL expired. `version` (the chapter row's updated_at) is appended as a
    query param so every rewrite reads from a fresh cache key."""
    def _do() -> bytes:
        resp = _get_direct_client().get(
            f"/object/{bucket}/{path}",
            params={"v": version} if version else None,
        )
        if resp.status_code >= 400:
            raise StorageUploadError(
                resp.status_code, resp.text, bucket, path, op="download"
            )
        return resp.content
    return _retry_sync(_do, what=f"download {bucket}/{path}")


def _sync_remove(bucket: str, paths: list[str]) -> None:
    _retry_sync(
        lambda: _get_storage().from_(bucket).remove(paths),
        what=f"remove {bucket} ({len(paths)} files)",
    )


def _sync_list(bucket: str, prefix: str, *, limit: int = 1000, offset: int = 0) -> list[dict]:
    # storage3's default is limit=100, which silently truncates listings for
    # any book with >100 chapters. Pass an explicit large page size; callers
    # that need all results must still paginate.
    return _retry_sync(
        lambda: _get_storage().from_(bucket).list(
            prefix,
            {"limit": limit, "offset": offset, "sortBy": {"column": "name", "order": "asc"}},
        ),
        what=f"list {bucket}/{prefix}",
    )


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
    """`version` (chapters.updated_at) cache-busts Supabase's CDN — see
    _sync_download. Pass it whenever the caller has the row's updated_at;
    without it an upserted object can be served stale until the CDN TTL."""
    data = await asyncio.to_thread(_sync_download, CHAPTER_TEXT_BUCKET, path, version)
    # New objects are gzip (magic 1f 8b); legacy objects are plain UTF-8 and skip
    # the gunzip branch — byte-identical to the pre-compression behaviour.
    if _is_gzip(data):
        data = _gunzip_decompress(data)
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
    """Delete a file from Supabase Storage."""
    try:
        await asyncio.to_thread(_sync_remove, bucket, [path])
    except Exception as e:
        logger.warning(f"Could not delete {bucket}/{path}: {e}")


async def delete_folder(bucket: str, prefix: str) -> None:
    """Delete every file under a prefix in Supabase Storage. Paginates until
    the listing is empty, since Supabase caps each list() page at 1000 items
    and a book with N chapters has N files in chapter-text/ and audio/."""
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
