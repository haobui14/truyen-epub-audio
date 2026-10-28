"""In-process read cache for catalog data, chapter text and per-user rows.

Correct only because the API runs ONE uvicorn worker on ONE replica (the same
assumption as the role/approval cache and the rate limiter): every write that
goes through the API bumps a global generation, which drops every entry at
once. TTLs exist only to bound staleness for writes that bypass the API — the
offline tooling in backend/scripts talks to Supabase directly.

Readers capture `generation()` BEFORE querying and pass it to `put`; a write
that lands while the query is in flight bumps the generation, so the
now-stale result is never stored.
"""
import hashlib
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Hashable, Optional

from fastapi import Request, Response
from starlette.types import ASGIApp, Receive, Scope, Send

_lock = threading.Lock()
_generation = 0


def _size(value: Any) -> int:
    """Approximate bytes held by a cached value. Response bodies dominate;
    small row dicts and ints get a flat estimate."""
    if isinstance(value, (bytes, str)):
        return len(value)
    if isinstance(value, tuple):
        return sum(_size(v) for v in value)
    return 512


class Store:
    """Thread-safe LRU with per-entry TTL and an optional byte budget,
    cleared wholesale by bump()."""

    def __init__(self, max_entries: int, max_bytes: Optional[int] = None) -> None:
        self._max = max_entries
        self._max_bytes = max_bytes
        self._bytes = 0
        # key -> (expires_at, size, value)
        self._data: "OrderedDict[Hashable, tuple[float, int, Any]]" = OrderedDict()

    def _drop(self, key: Hashable) -> None:
        _expires, size, _value = self._data.pop(key)
        self._bytes -= size

    def get(self, key: Hashable) -> Optional[Any]:
        with _lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            expires_at, _size_, value = hit
            if time.monotonic() >= expires_at:
                self._drop(key)
                return None
            self._data.move_to_end(key)
            return value

    def put(
        self,
        key: Hashable,
        value: Any,
        ttl: float,
        gen: int,
        *,
        only_if_absent: bool = False,
        replaces: Optional[Callable[[Any], bool]] = None,
    ) -> None:
        """only_if_absent: for read paths of rows that writes refresh in place
        (settings, progress) — a slow read must not overwrite the newer row a
        concurrent write already stored.
        replaces: called with the current value (if any) under the lock; the
        put is skipped when it returns False."""
        size = _size(value)
        with _lock:
            if gen != _generation:
                return
            if self._max_bytes is not None and size > self._max_bytes // 4:
                return  # one oversized body must not flush everything else
            if key in self._data:
                if only_if_absent:
                    return
                if replaces is not None and not replaces(self._data[key][2]):
                    return
                self._drop(key)
            self._data[key] = (time.monotonic() + ttl, size, value)
            self._bytes += size
            while len(self._data) > self._max or (
                self._max_bytes is not None and self._bytes > self._max_bytes
            ):
                self._drop(next(iter(self._data)))

    def pop(self, key: Hashable) -> None:
        with _lock:
            if key in self._data:
                self._drop(key)

    def purge_expired(self) -> None:
        now = time.monotonic()
        with _lock:
            for key in [k for k, (expires_at, _s, _v) in self._data.items() if now >= expires_at]:
                self._drop(key)

    def clear(self) -> None:
        with _lock:
            self._data.clear()
            self._bytes = 0


# Books, chapter lists (~150 KB for a 1,000-chapter page), genres, settings,
# chapter_index lookups. The byte budget matters because the chapter-list
# endpoint is public and keyed by page_size, so callers can mint new entries.
catalog = Store(max_entries=512, max_bytes=24 * 1024 * 1024)
# Chapter text payloads (~10–60 KB each).
texts = Store(max_entries=200, max_bytes=12 * 1024 * 1024)
# Last known user_progress row per (user_id, book_id).
progress = Store(max_entries=1000)

_STORES = (catalog, texts, progress)


def generation() -> int:
    return _generation


def bump() -> None:
    """Invalidate everything. Called around every catalog write."""
    global _generation
    with _lock:
        _generation += 1
    for store in _STORES:
        store.clear()


def purge_expired() -> None:
    """Expired entries otherwise sit in memory until read or LRU-evicted —
    chapter lists for big books are ~150 KB each."""
    for store in _STORES:
        store.purge_expired()


def etag_for(body: bytes) -> str:
    # Weak: the gzip middleware re-encodes the body, so it is never byte-exact.
    return 'W/"' + hashlib.blake2b(body, digest_size=12).hexdigest() + '"'


def _matches(if_none_match: str, etag: str) -> bool:
    if if_none_match.strip() == "*":
        return True
    bare = etag.removeprefix("W/")
    return any(tag.strip().removeprefix("W/") == bare for tag in if_none_match.split(","))


def conditional_json(
    request: Request, body: bytes, etag: str, cache_control: str = "no-cache"
) -> Response:
    """JSON response with an ETag; 304 when the client already holds it.

    Only browsers/WebViews revalidate (their HTTP cache adds If-None-Match on
    its own and hands JS the cached 200), so clients that never send the
    header — the Android service's HttpURLConnection, older APKs' fetch code —
    always get the full body exactly as before.
    """
    headers = {"ETag": etag, "Cache-Control": cache_control}
    inm = request.headers.get("if-none-match")
    if inm and _matches(inm, etag):
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


# Every route that writes books, chapters, chapter text, covers or genres
# lives under one of these prefixes.
_CATALOG_WRITE_PREFIXES = ("/api/books", "/api/chapters", "/api/upload", "/api/genres")
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class CacheInvalidationMiddleware:
    """Bump the cache generation before and after any catalog write.

    Before: reads racing the write can't be served from pre-write entries.
    After: anything cached while the write was half-applied is dropped.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] not in _READ_METHODS
            and scope["path"].startswith(_CATALOG_WRITE_PREFIXES)
        ):
            bump()
            try:
                await self.app(scope, receive, send)
            finally:
                bump()
            return
        await self.app(scope, receive, send)


# Strong references: asyncio keeps only weak ones to running tasks, so an
# untracked background task can be garbage-collected mid-run (and then its
# final bump never fires).
_tracked_tasks: set = set()


def _on_tracked_done(task) -> None:
    _tracked_tasks.discard(task)
    bump()


def bump_when_done(task) -> None:
    """For background work a write request spawns (parse, reparse): the
    request's own bump fires long before the task finishes writing."""
    _tracked_tasks.add(task)
    task.add_done_callback(_on_tracked_done)
