from fastapi import APIRouter, Depends

from app.database import get_client
from app.dependencies import get_current_user
from app.models.settings import SettingsUpsert, SettingsResponse

router = APIRouter(prefix="/api/settings", tags=["settings"])

_DEFAULTS = {"playback_rate": 1, "playback_pitch": 1}


@router.get("", response_model=SettingsResponse)
async def get_settings(user: dict = Depends(get_current_user)):
    """Return the authenticated user's playback settings (or defaults)."""
    db = get_client()
    result = (
        db.table("user_settings")
        .select("*")
        .eq("user_id", user["id"])
        .maybe_single()
        .execute()
    )
    if result and result.data:
        return result.data
    # No row yet — return defaults without inserting
    return {
        "user_id": user["id"],
        **_DEFAULTS,
        "updated_at": "1970-01-01T00:00:00+00:00",
    }


@router.put("", response_model=SettingsResponse)
async def save_settings(
    body: SettingsUpsert, user: dict = Depends(get_current_user)
):
    """Upsert playback rate & pitch for the authenticated user."""
    db = get_client()
    data = {
        "user_id": user["id"],
        "playback_rate": body.playback_rate,
        "playback_pitch": body.playback_pitch,
        "updated_at": "now()",
    }
    result = (
        db.table("user_settings")
        .upsert(data, on_conflict="user_id")
        .execute()
    )
    return result.data[0]
