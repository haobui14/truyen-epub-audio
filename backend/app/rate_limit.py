"""Tiny in-process rate limiter.

Login/signup run bcrypt (~100–300ms of CPU each) and signups create rows, so
both need a brake against brute force and accidental client loops. A sliding
window per (bucket, key) in a plain dict is enough here: the app runs a single
uvicorn worker (same assumption as the TTS queue and the auth caches), so
in-process state IS global state.
"""
import time
from collections import deque

from fastapi import HTTPException, Request

_windows: dict[tuple[str, str], deque[float]] = {}
_LIMIT_MESSAGE = "Thử lại sau ít phút — quá nhiều yêu cầu."

# Bound total tracked keys so a scan across many IPs can't grow memory forever.
_MAX_KEYS = 10_000


def client_ip(request: Request) -> str:
    """Railway sits behind a proxy — the real client is the first hop of
    x-forwarded-for; request.client is the proxy itself."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check(bucket: str, key: str, limit: int, window_seconds: float) -> None:
    """Raise 429 when (bucket, key) exceeds `limit` calls per window."""
    now = time.monotonic()
    if len(_windows) > _MAX_KEYS:
        _windows.clear()
    dq = _windows.setdefault((bucket, key), deque())
    while dq and now - dq[0] >= window_seconds:
        dq.popleft()
    if len(dq) >= limit:
        raise HTTPException(status_code=429, detail=_LIMIT_MESSAGE)
    dq.append(now)
