from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.database import get_client
from app.dependencies import get_current_user
from app.models.progress import ProgressUpsert, ProgressResponse

router = APIRouter(prefix="/api/progress", tags=["progress"])


@router.put("", response_model=ProgressResponse)
async def save_progress(body: ProgressUpsert, user: dict = Depends(get_current_user)):
    """Upsert progress for user + book (one row per book)."""
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
    return result.data[0]


@router.get("/chapter/{chapter_id}", response_model=Optional[ProgressResponse])
async def get_chapter_progress(
    chapter_id: str,
    user: dict = Depends(get_current_user),
):
    """Get progress for a specific chapter."""
    db = get_client()
    result = (
        db.table("user_progress")
        .select("*")
        .eq("user_id", user["id"])
        .eq("chapter_id", chapter_id)
        .maybe_single()
        .execute()
    )
    return result.data


@router.get("/my-books", response_model=List[Dict[str, Any]])
async def get_my_books(user: dict = Depends(get_current_user)):
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
async def get_book_progress(
    book_id: str,
    user: dict = Depends(get_current_user),
):
    """Get progress for a book."""
    db = get_client()
    result = (
        db.table("user_progress")
        .select("*")
        .eq("user_id", user["id"])
        .eq("book_id", book_id)
        .maybe_single()
        .execute()
    )
    return result.data
