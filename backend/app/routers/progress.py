import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app import response_cache
from app.database import get_client
from app.dependencies import get_current_user
from app.models.progress import ProgressUpsert, ProgressResponse

router = APIRouter(prefix="/api/progress", tags=["progress"])

# Every user_progress write goes through save_progress below, so the last row
# it wrote (or a read fetched) is authoritative for this process. Cascade
# deletes from book/chapter deletes come through catalog writes, which clear
# this cache; the TTL bounds staleness after offline scripts delete chapters.
PROGRESS_TTL_SECONDS = 300
# An unchanged position is only answered from cache within this window, so a
# skipped write leaves updated_at (which /my-books sorts by) at most this
# stale. Position 0 always writes: resets send it, and the reset flow uses
# the returned updated_at to tell older background sessions apart.
DEDUPE_WINDOW_SECONDS = 60
# chapter_index only changes when chapters are reordered/split/deleted —
# catalog writes that clear the cache.
CHAPTER_INDEX_TTL_SECONDS = 600
# Cached "this user has no progress row for this book".
_NO_ROW = object()


def _chapter_index(chapter_id: str) -> Optional[int]:
    key = ("chidx", chapter_id)
    cached = response_cache.catalog.get(key)
    if cached is not None:
        return cached
    gen = response_cache.generation()
    db = get_client()
    ch = (
        db.table("chapters")
        .select("chapter_index")
        .eq("id", chapter_id)
        .maybe_single()
        .execute()
    )
    index = ((ch.data or {}) if ch else {}).get("chapter_index")
    if index is not None:
        response_cache.catalog.put(key, index, CHAPTER_INDEX_TTL_SECONDS, gen)
    return index


def _public(row: dict) -> dict:
    """Cached rows carry a private write timestamp; never return it."""
    return {k: v for k, v in row.items() if not k.startswith("_")}


def _flatten(row: dict) -> dict:
    """Turn an embedded `chapters(chapter_index)` into the flat field."""
    row = dict(row)
    chapter = row.pop("chapters", None) or {}
    row["chapter_index"] = chapter.get("chapter_index")
    return row


# All handlers here are sync (`def`) so FastAPI runs them on the worker thread
# pool: the blocking Supabase client would otherwise stall the single uvicorn
# worker's event loop, and progress writes fire constantly during playback.
@router.put("", response_model=ProgressResponse)
def save_progress(body: ProgressUpsert, user: dict = Depends(get_current_user)):
    """Upsert progress for user + book (one row per book)."""
    key = (user["id"], body.book_id)
    # Clients re-send an unchanged position constantly (every app foreground
    # reconciles, paused players re-report). Answer those from the last
    # written row instead of rewriting it.
    last = response_cache.progress.get(key)
    if (
        isinstance(last, dict)
        and body.progress_value > 0
        and time.monotonic() - last.get("_written_at", 0) < DEDUPE_WINDOW_SECONDS
        and last["chapter_id"] == body.chapter_id
        and last["progress_value"] == body.progress_value
        and last.get("total_value") == body.total_value
    ):
        return _public(last)

    gen = response_cache.generation()
    db = get_client()
    data = {
        "user_id": user["id"],
        "book_id": body.book_id,
        "chapter_id": body.chapter_id,
        "progress_value": body.progress_value,
        "total_value": body.total_value,
        "updated_at": "now()",
    }
    result = (
        db.table("user_progress")
        .upsert(data, on_conflict="user_id,book_id")
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save progress")
    row = result.data[0]
    row["chapter_index"] = _chapter_index(row["chapter_id"])
    # Two devices can write the same book concurrently on different worker
    # threads; keep whichever row the database committed last, not whichever
    # thread reached the cache last (same-format ISO timestamps sort as text).
    response_cache.progress.put(
        key,
        {**row, "_written_at": time.monotonic()},
        PROGRESS_TTL_SECONDS,
        gen,
        replaces=lambda old: not isinstance(old, dict)
        or str(row.get("updated_at", "")) >= str(old.get("updated_at", "")),
    )
    return dict(row)


@router.get("/chapter/{chapter_id}", response_model=Optional[ProgressResponse])
def get_chapter_progress(
    chapter_id: str,
    user: dict = Depends(get_current_user),
):
    """Get progress for a specific chapter."""
    db = get_client()
    result = (
        db.table("user_progress")
        .select("*, chapters(chapter_index)")
        .eq("user_id", user["id"])
        .eq("chapter_id", chapter_id)
        .maybe_single()
        .execute()
    )
    if not result or not result.data:
        return None
    return _flatten(result.data)


@router.get("/my-books", response_model=List[Dict[str, Any]])
def get_my_books(user: dict = Depends(get_current_user)):
    """
    Return one entry per book the user has progress on.
    Each entry contains book metadata + the last-stopped chapter info.
    Sorted by most recently updated.
    """
    db = get_client()
    result = (
        db.table("user_progress")
        .select(
            "progress_value, total_value, updated_at, "
            "books(id, title, author, cover_url, total_chapters), "
            "chapters(id, chapter_index, title)"
        )
        .eq("user_id", user["id"])
        .order("updated_at", desc=True)
        .execute()
    )
    if not result.data:
        return []

    rows = []
    for row in result.data:
        book = row.get("books") or {}
        chapter = row.get("chapters") or {}
        rows.append({
            "book": book,
            "chapter": chapter,
            "progress_value": row["progress_value"],
            "total_value": row["total_value"],
            "updated_at": row["updated_at"],
        })
    return rows


@router.get("/book/{book_id}", response_model=Optional[ProgressResponse])
def get_book_progress(
    book_id: str,
    user: dict = Depends(get_current_user),
):
    """Get progress for a book."""
    key = (user["id"], book_id)
    cached = response_cache.progress.get(key)
    if cached is _NO_ROW:
        return None
    if cached is not None:
        return _public(cached)
    gen = response_cache.generation()
    db = get_client()
    result = (
        db.table("user_progress")
        .select("*, chapters(chapter_index)")
        .eq("user_id", user["id"])
        .eq("book_id", book_id)
        .maybe_single()
        .execute()
    )
    row = _flatten(result.data) if result and result.data else None
    response_cache.progress.put(
        key, row if row is not None else _NO_ROW, PROGRESS_TTL_SECONDS, gen, only_if_absent=True
    )
    return row
