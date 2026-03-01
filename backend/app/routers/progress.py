from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.database import get_client
from app.dependencies import get_current_user
from app.models.progress import ProgressUpsert, ProgressResponse

router = APIRouter(prefix="/api/progress", tags=["progress"])


@router.put("", response_model=ProgressResponse)
async def save_progress(body: ProgressUpsert, user: dict = Depends(get_current_user)):
    """Upsert progress for user + book + chapter + type."""
    db = get_client()
    data = {
        "user_id": user["id"],
        "book_id": body.book_id,
        "chapter_id": body.chapter_id,
        "progress_type": body.progress_type,
        "progress_value": body.progress_value,
        "total_value": body.total_value,
        "updated_at": "now()",
    }
    result = (
        db.table("user_progress")
        .upsert(data, on_conflict="user_id,book_id,chapter_id,progress_type")
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save progress")
    return result.data[0]


@router.get("/chapter/{chapter_id}", response_model=Optional[ProgressResponse])
async def get_chapter_progress(
    chapter_id: str,
    progress_type: str = "read",
    user: dict = Depends(get_current_user),
):
    """Get progress for a specific chapter."""
    db = get_client()
    result = (
        db.table("user_progress")
        .select("*")
        .eq("user_id", user["id"])
        .eq("chapter_id", chapter_id)
        .eq("progress_type", progress_type)
        .maybe_single()
        .execute()
    )
    return result.data


@router.get("/book/{book_id}", response_model=List[ProgressResponse])
async def get_book_progress(
    book_id: str,
    progress_type: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Get all progress entries for a book."""
    db = get_client()
    query = (
        db.table("user_progress")
        .select("*")
        .eq("user_id", user["id"])
        .eq("book_id", book_id)
    )
    if progress_type:
        query = query.eq("progress_type", progress_type)
    result = query.order("updated_at", desc=True).execute()
    return result.data
