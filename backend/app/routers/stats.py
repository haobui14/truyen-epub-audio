import math
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_client
from app.dependencies import get_current_user

router = APIRouter(prefix="/api/stats", tags=["stats"])


class CompleteChapterRequest(BaseModel):
    chapter_id: str
    book_id: str
    mode: str  # 'read' or 'listen'
    word_count: int = 0


@router.post("/complete-chapter")
async def complete_chapter(
    body: CompleteChapterRequest,
    user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """
    Award XP for completing a chapter (read or listen).
    No-ops silently if the chapter+mode was already completed.
    XP formula: max(10, ceil(word_count / 50)) for reading; 1.5x for listening.

    Completion deduplication is stored as text[] arrays in user_stats
    (completed_listen_ids / completed_read_ids) — one row per user, no
    separate completions table needed.
    """
    try:
        db = get_client()
        user_id = user["id"]

        if body.mode not in ("read", "listen"):
            return {"exp_earned": 0, "already_completed": False, "total_exp": 0}

        completed_key = "completed_listen_ids" if body.mode == "listen" else "completed_read_ids"
        now_iso = datetime.now(timezone.utc).isoformat()

        # Single read — fetches aggregates AND completed-id arrays together
        stats_row = (
            db.table("user_stats")
            .select("*")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )

        if stats_row and stats_row.data:
            s = stats_row.data
            completed_ids: list = s.get(completed_key) or []
            if body.chapter_id in completed_ids:
                return {"exp_earned": 0, "already_completed": True, "total_exp": s["total_exp"]}

            base_exp = max(10, math.ceil(body.word_count / 50)) if body.word_count > 0 else 10
            exp_earned = int(base_exp * 1.5) if body.mode == "listen" else base_exp

            update_data: Dict[str, Any] = {
                "total_exp": s["total_exp"] + exp_earned,
                "total_words_read": s["total_words_read"] + body.word_count,
                "updated_at": now_iso,
                completed_key: completed_ids + [body.chapter_id],
            }
            if body.mode == "read":
                update_data["total_chapters_read"] = s["total_chapters_read"] + 1
            else:
                update_data["total_chapters_listened"] = s["total_chapters_listened"] + 1
            db.table("user_stats").update(update_data).eq("user_id", user_id).execute()
            new_total = s["total_exp"] + exp_earned
        else:
            base_exp = max(10, math.ceil(body.word_count / 50)) if body.word_count > 0 else 10
            exp_earned = int(base_exp * 1.5) if body.mode == "listen" else base_exp

            db.table("user_stats").insert({
                "user_id": user_id,
                "total_exp": exp_earned,
                "total_chapters_read": 1 if body.mode == "read" else 0,
                "total_chapters_listened": 1 if body.mode == "listen" else 0,
                "total_words_read": body.word_count,
                "updated_at": now_iso,
                completed_key: [body.chapter_id],
                "completed_read_ids" if body.mode == "listen" else "completed_listen_ids": [],
            }).execute()
            new_total = exp_earned

        return {
            "exp_earned": exp_earned,
            "already_completed": False,
            "total_exp": new_total,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Stats update failed: {exc}") from exc


@router.get("/me")
async def get_my_stats(user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """Return aggregate XP and reading stats for the current user."""
    try:
        db = get_client()
        result = (
            db.table("user_stats")
            .select("user_id, total_exp, total_chapters_read, total_chapters_listened, total_words_read, updated_at")
            .eq("user_id", user["id"])
            .maybe_single()
            .execute()
        )
        if not result or not result.data:
            return {
                "user_id": user["id"],
                "total_exp": 0,
                "total_chapters_read": 0,
                "total_chapters_listened": 0,
                "total_words_read": 0,
                "updated_at": None,
            }
        return result.data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Stats fetch failed: {exc}") from exc
