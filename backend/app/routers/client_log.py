"""Client error reports.

Device-side failures (Android WebView, PWA, web) used to vanish without a
trace — the only debugging tool was reproducing by hand. The app now posts
uncaught errors here; rows land in the client_log table AND mirror into the
backend log stream, so Railway's log view shows them live.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel

from app import rate_limit
from app.database import get_client
from app.dependencies import get_admin_user, get_optional_user

router = APIRouter(prefix="/api", tags=["client-log"])
logger = logging.getLogger(__name__)

_MAX_TEXT = 4000


class ClientLogBody(BaseModel):
    message: str
    stack: Optional[str] = None
    url: Optional[str] = None
    platform: Optional[str] = None  # "android" | "pwa" | "web"
    app_version: Optional[str] = None


# Sync handlers (`def`) per the project convention: the blocking Supabase
# client runs on the worker thread pool, off the single worker's event loop.
@router.post("/client-log", status_code=204)
def post_client_log(
    body: ClientLogBody,
    request: Request,
    user: Optional[dict] = Depends(get_optional_user),
):
    """Record one client-side error. Anonymous allowed (errors can hit the
    login screen too); user_id is attached when a valid token is present."""
    rate_limit.check(
        "client-log", rate_limit.client_ip(request), limit=30, window_seconds=3600
    )
    message = body.message.strip()
    if not message:
        return Response(status_code=204)
    row = {
        "user_id": user["id"] if user else None,
        "platform": (body.platform or "").strip()[:40] or None,
        "app_version": (body.app_version or "").strip()[:40] or None,
        "url": (body.url or "").strip()[:500] or None,
        "message": message[:_MAX_TEXT],
        "stack": (body.stack or "")[:_MAX_TEXT] or None,
        "user_agent": (request.headers.get("user-agent") or "")[:500] or None,
    }
    # Mirror into the server log so reports show up in Railway's live logs
    # without querying the table.
    logger.warning(
        "client-log [%s %s] %s | %s",
        row["platform"] or "?",
        row["app_version"] or "?",
        row["message"][:300],
        row["url"] or "",
    )
    try:
        get_client().table("client_log").insert(row).execute()
    except Exception as e:
        # Logging must never take the app down with it.
        logger.warning("client_log insert failed: %s", e)
    return Response(status_code=204)


@router.get("/client-log")
def list_client_log(
    limit: int = Query(100, ge=1, le=500),
    _admin: dict = Depends(get_admin_user),
):
    """Admin: newest error reports first."""
    rows = (
        get_client()
        .table("client_log")
        .select("*")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return rows.data or []
