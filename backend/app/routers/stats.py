from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.database import get_client
from app.dependencies import get_current_user

router = APIRouter(prefix="/api/stats", tags=["stats"])

# EXP is derived from reading progress instead of being tracked per chapter:
# every chapter before the one a user is on in a book counts as done, and a
# book sitting on its last chapter counts in full (the same "Hoàn thành" rule
# the profile page uses). One read when the profile opens replaces a write per
# finished chapter — the old per-user completed-id arrays were rewritten whole
# on every completion and were the database's largest WAL producer.
# 30 keeps existing users at roughly the level the old word-count formula gave.
EXP_PER_CHAPTER = 30


@router.post("/complete-chapter")
async def complete_chapter() -> Dict[str, Any]:
    """Retired: XP is derived from progress (see get_my_stats). Kept as a
    no-op — no auth, no DB — so installed APKs that still report completions
    get a 200 instead of a 404, and never trigger a token refresh for it."""
    return {"exp_earned": 0, "already_completed": True, "total_exp": None}


# Sync handler (`def`): FastAPI runs it on the worker thread pool so the
# blocking Supabase client stays off the single worker's event loop.
@router.get("/me")
def get_my_stats(user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """Return the caller's EXP and chapter totals, computed from user_progress."""
    try:
        db = get_client()
        result = (
            db.table("user_progress")
            .select("books(total_chapters), chapters(chapter_index)")
            .eq("user_id", user["id"])
            .execute()
        )
        chapters_completed = 0
        for row in result.data or []:
            index = (row.get("chapters") or {}).get("chapter_index")
            total = (row.get("books") or {}).get("total_chapters") or 0
            if index is None:
                continue
            chapters_completed += total if total and index + 1 >= total else index
        return {
            "user_id": user["id"],
            "total_exp": chapters_completed * EXP_PER_CHAPTER,
            "chapters_completed": chapters_completed,
            # Legacy fields for installed APKs, whose profile still renders
            # read/listened/words cards. Read vs listen is no longer tracked.
            "total_chapters_read": chapters_completed,
            "total_chapters_listened": 0,
            "total_words_read": 0,
            "updated_at": None,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Stats fetch failed: {exc}") from exc
