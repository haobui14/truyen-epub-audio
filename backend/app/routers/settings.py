from fastapi import APIRouter, Depends

from app import response_cache
from app.database import get_client
from app.dependencies import get_current_user
from app.models.settings import SettingsUpsert, SettingsResponse

router = APIRouter(prefix="/api/settings", tags=["settings"])

_DEFAULTS = {"playback_rate": 1, "playback_pitch": 1}

# Settings are read on every player open but only change through PUT below,
# which refreshes the cached row, so the TTL is just a backstop.
SETTINGS_TTL_SECONDS = 600


# Sync handlers (`def`): FastAPI runs them on the worker thread pool so the
# blocking Supabase client stays off the single worker's event loop.
@router.get("", response_model=SettingsResponse)
def get_settings(user: dict = Depends(get_current_user)):
    """Return the authenticated user's playback settings (or defaults)."""
    key = ("settings", user["id"])
    cached = response_cache.catalog.get(key)
    if cached is not None:
        return cached
    gen = response_cache.generation()
    db = get_client()
    result = (
        db.table("user_settings")
        .select("*")
        .eq("user_id", user["id"])
        .maybe_single()
        .execute()
    )
    if result and result.data:
        row = result.data
    else:
        # No row yet — return defaults without inserting
        row = {
            "user_id": user["id"],
            **_DEFAULTS,
            "updated_at": "1970-01-01T00:00:00+00:00",
        }
    response_cache.catalog.put(key, row, SETTINGS_TTL_SECONDS, gen, only_if_absent=True)
    return row


@router.put("", response_model=SettingsResponse)
def save_settings(
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
    row = result.data[0]
    response_cache.catalog.put(
        ("settings", user["id"]), row, SETTINGS_TTL_SECONDS, response_cache.generation()
    )
    return row
