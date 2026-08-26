import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request
from jose import jwt
from pydantic import BaseModel, EmailStr

from app import rate_limit
from app.config import settings
from app.database import get_client
from app.dependencies import (
    get_current_user,
    get_admin_user,
    _lookup_role,
    invalidate_user_caches,
    lookup_approval,
    PENDING_MESSAGE,
    REJECTED_MESSAGE,
)

# Every handler in this router is deliberately sync (`def`, not `async def`):
# FastAPI runs sync handlers on its worker thread pool, which keeps the
# blocking Supabase client AND bcrypt (~100–300ms of pure CPU per hash/verify)
# off the single worker's event loop. As `async def`, one login attempt froze
# every in-flight request for the duration of the bcrypt check.

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger(__name__)

_ALGORITHM = "HS256"
_ACCESS_TOKEN_EXPIRE_MINUTES = 60
_REFRESH_TOKEN_EXPIRE_DAYS = 90

# Direct bcrypt instead of passlib: passlib 1.7.4 is unmaintained and pinned
# the whole app to bcrypt 4.0.1. Existing hashes are standard $2b$ strings, so
# they keep verifying unchanged.


def _hash_password(password: str) -> str:
    # passlib silently truncated to bcrypt's 72-byte input limit; keep that
    # behaviour so any existing long-password account still round-trips.
    return bcrypt.hashpw(
        password.encode("utf-8")[:72], bcrypt.gensalt()
    ).decode("ascii")


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(
            password.encode("utf-8")[:72], password_hash.encode("ascii")
        )
    except ValueError:
        # Malformed stored hash — wrong password, never a 500.
        return False


class AuthRequest(BaseModel):
    email: EmailStr
    password: str


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str = ""
    user_id: str
    email: str
    role: str = "user"
    display_name: str | None = None
    avatar_base64: str | None = None


class SignupResponse(BaseModel):
    """Signup deliberately returns NO tokens: the account exists but cannot be
    used until an admin approves it."""
    status: str
    message: str


class ApprovalDecision(BaseModel):
    status: str  # 'approved' | 'rejected' | 'pending'


class UpdateProfileRequest(BaseModel):
    display_name: str | None = None
    avatar_base64: str | None = None


class RefreshRequest(BaseModel):
    refresh_token: str


def _create_access_token(user_id: str, email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=_ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode(
        {"sub": user_id, "email": email, "exp": expire},
        settings.jwt_secret,
        algorithm=_ALGORITHM,
    )


def _create_refresh_token(user_id: str) -> str:
    db = get_client()
    token = secrets.token_hex(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=_REFRESH_TOKEN_EXPIRE_DAYS)
    db.table("refresh_tokens").insert({
        "token": token,
        "user_id": user_id,
        "expires_at": expires_at.isoformat(),
    }).execute()
    return token


def _revoke_refresh_token(token: str) -> None:
    db = get_client()
    db.table("refresh_tokens").delete().eq("token", token).execute()


def _cleanup_expired_tokens(user_id: str) -> None:
    """Delete this user's already-expired refresh tokens.

    Keeps the table bounded now that /refresh no longer hard-revokes the
    presented token on rotation (see refresh()). Best-effort only — a cleanup
    failure must never fail the refresh itself.
    """
    try:
        db = get_client()
        now = datetime.now(timezone.utc).isoformat()
        db.table("refresh_tokens").delete().eq("user_id", user_id).lt(
            "expires_at", now
        ).execute()
    except Exception:
        pass


def _log_signup(request: Request, user_id: str, email: str) -> None:
    """Audit row for every account created. Best effort — a logging failure
    must never turn a successful registration into an error for the user."""
    try:
        db = get_client()
        # Railway sits behind a proxy, so request.client.host is the proxy.
        forwarded = request.headers.get("x-forwarded-for", "")
        ip = forwarded.split(",")[0].strip() if forwarded else (
            request.client.host if request.client else None
        )
        db.table("signup_log").insert({
            "user_id": user_id,
            "email": email,
            "ip": ip,
            "user_agent": (request.headers.get("user-agent") or "")[:500],
        }).execute()
    except Exception as e:
        logger.warning("signup_log insert failed for %s: %s", email, e)


@router.post("/signup", response_model=SignupResponse)
def signup(body: AuthRequest, request: Request):
    # Signups are admin-approved anyway; the limit just stops bulk-created
    # pending rows and repeated bcrypt work from one address.
    rate_limit.check("signup", rate_limit.client_ip(request), limit=5, window_seconds=3600)
    db = get_client()
    try:
        existing = db.table("users").select("id").eq("email", body.email).maybe_single().execute()
        if existing and existing.data:
            raise HTTPException(status_code=400, detail="Email đã được đăng ký")

        user_id = str(uuid.uuid4())
        password_hash = _hash_password(body.password)
        # approval_status is left to the column default ('pending') so this
        # insert still works on a database where the migration hasn't been run
        # yet — one less way for a deploy to take signups down.
        db.table("users").insert({
            "id": user_id,
            "email": body.email,
            "password_hash": password_hash,
        }).execute()
        _log_signup(request, user_id, body.email)

        logger.info("New signup awaiting approval: %s (%s)", body.email, user_id)
        # No tokens: the account is inert until an admin approves it.
        return SignupResponse(status="pending", message=PENDING_MESSAGE)
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e).lower()
        if "not found" in error_msg or "does not exist" in error_msg:
            raise HTTPException(status_code=500, detail="Database schema not initialized. Run the SQL migrations.")
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/update-profile")
def update_profile(
    body: UpdateProfileRequest,
    user: dict = Depends(get_current_user),
):
    user_id = user["id"]
    # Guard against huge payloads (500 KB base64 ≈ 375 KB raw image)
    if body.avatar_base64 and len(body.avatar_base64) > 500_000:
        raise HTTPException(status_code=400, detail="Ảnh quá lớn (tối đa ~375 KB)")
    db = get_client()
    updates: dict = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name.strip() or None
    if body.avatar_base64 is not None:
        updates["avatar_base64"] = body.avatar_base64 or None
    if not updates:
        raise HTTPException(status_code=400, detail="Không có gì để cập nhật")
    result = (
        db.table("users")
        .update(updates)
        .eq("id", user_id)
        .execute()
    )
    row = result.data[0] if result.data else {}
    return {
        "display_name": row.get("display_name"),
        "avatar_base64": row.get("avatar_base64"),
    }


@router.post("/login", response_model=AuthResponse)
def login(body: AuthRequest, request: Request):
    # Each attempt costs a bcrypt verify (~100–300ms CPU) — brake brute force
    # per source address. 10 per 5 minutes is far above honest retry rates.
    rate_limit.check("login", rate_limit.client_ip(request), limit=10, window_seconds=300)
    db = get_client()
    try:
        result = (
            db.table("users")
            .select("id, email, password_hash, display_name, avatar_base64")
            .eq("email", body.email)
            .maybe_single()
            .execute()
        )
        if not result or not result.data:
            raise HTTPException(status_code=401, detail="Email hoặc mật khẩu không đúng")
        
        user_data = result.data
        password_hash = user_data.get("password_hash")
        if not password_hash or not _verify_password(body.password, password_hash):
            raise HTTPException(status_code=401, detail="Email hoặc mật khẩu không đúng")

        user_id = user_data["id"]
        # Checked separately (not selected above) so an un-migrated database
        # keeps letting existing users in rather than 503-ing every login.
        approval = lookup_approval(user_id)
        if approval == "pending":
            raise HTTPException(status_code=403, detail=PENDING_MESSAGE)
        if approval != "approved":
            raise HTTPException(status_code=403, detail=REJECTED_MESSAGE)

        access_token = _create_access_token(user_id, user_data["email"])
        refresh_token = _create_refresh_token(user_id)
        return AuthResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user_id=user_id,
            email=user_data["email"],
            role=_lookup_role(user_id),
            display_name=user_data.get("display_name"),
            avatar_base64=user_data.get("avatar_base64"),
        )
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e).lower()
        if "not found" in error_msg or "does not exist" in error_msg:
            raise HTTPException(status_code=500, detail="Database schema not initialized. Run the SQL migrations.")
        # Unknown failure (DB unreachable, query timeout, transient Supabase
        # outage). Don't return 401 — the frontend would show "wrong password"
        # for what is really a backend hiccup. 503 lets the UI show a
        # try-again message.
        raise HTTPException(status_code=503, detail="Đăng nhập tạm thời không khả dụng")


@router.post("/refresh", response_model=AuthResponse)
def refresh(body: RefreshRequest):
    db = get_client()
    try:
        row = (
            db.table("refresh_tokens")
            .select("user_id, expires_at")
            .eq("token", body.refresh_token)
            .maybe_single()
            .execute()
        )
        if not row or not row.data:
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

        expires_at = datetime.fromisoformat(row.data["expires_at"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires_at:
            _revoke_refresh_token(body.refresh_token)
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

        user_id = row.data["user_id"]
        approval = lookup_approval(user_id)
        if approval != "approved":
            # Revoking access has to bite on the refresh path too, otherwise a
            # rejected user keeps riding a valid refresh token for 90 days.
            raise HTTPException(
                status_code=403,
                detail=PENDING_MESSAGE if approval == "pending" else REJECTED_MESSAGE,
            )
        user_row = db.table("users").select("email, display_name, avatar_base64").eq("id", user_id).maybe_single().execute()
        if not user_row or not user_row.data:
            raise HTTPException(status_code=401, detail="User not found")

        u = user_row.data
        email = u["email"]
        # Issue a fresh refresh token but DO NOT hard-revoke the presented one.
        # Destructive rotation (delete-before-confirm) is the main cause of the
        # "randomly logged out" reports: if the response is lost (mobile screen
        # off, gateway timeout after the server already rotated), the app is
        # killed mid-persist, or two contexts (a second tab, or a rebinding
        # Android WebView) refresh near-simultaneously, the old token gets
        # replayed — and a hard-revoke would 401, which the client treats as
        # "session dead" → clearAuth → logout. Leaving the old token valid until
        # its natural 90-day expiry makes any such replay simply succeed. We
        # still roll forward (a new token every refresh) and prune this user's
        # already-expired tokens so the table stays bounded.
        _cleanup_expired_tokens(user_id)
        new_refresh_token = _create_refresh_token(user_id)
        access_token = _create_access_token(user_id, email)
        return AuthResponse(
            access_token=access_token,
            refresh_token=new_refresh_token,
            user_id=user_id,
            email=email,
            role=_lookup_role(user_id),
            display_name=u.get("display_name"),
            avatar_base64=u.get("avatar_base64"),
        )
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e).lower()
        if "not found" in error_msg or "does not exist" in error_msg:
            raise HTTPException(status_code=500, detail="Database schema not initialized. Run the SQL migrations.")
        # Unknown failure (DB unreachable, query timeout, transient Supabase
        # outage). Don't return 401 — the client treats that as "token rejected"
        # and signs the user out. 503 keeps the session intact so the user can
        # retry once the backend recovers.
        raise HTTPException(status_code=503, detail="Token refresh temporarily unavailable")


@router.get("/users")
def list_users(_admin: dict = Depends(get_admin_user)):
    """Every account with its approval state — the admin approval queue."""
    db = get_client()
    rows = (
        db.table("users")
        .select("id,email,display_name,created_at,approval_status,approval_decided_at")
        .order("created_at", desc=True)
        .execute()
    )
    return rows.data or []


@router.post("/users/{user_id}/approval")
def decide_approval(
    user_id: str,
    body: ApprovalDecision,
    admin: dict = Depends(get_admin_user),
):
    """Approve, reject, or move an account back to pending."""
    if body.status not in ("approved", "rejected", "pending"):
        raise HTTPException(status_code=400, detail="Trạng thái không hợp lệ")

    db = get_client()
    row = db.table("users").select("id,email").eq("id", user_id).maybe_single().execute()
    if not row or not row.data:
        raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

    db.table("users").update({
        "approval_status": body.status,
        "approval_decided_at": datetime.now(timezone.utc).isoformat(),
        "approval_decided_by": admin["id"],
    }).eq("id", user_id).execute()

    # The read/listen gate caches approval per user — drop the entry so the
    # decision bites immediately instead of after the cache TTL.
    invalidate_user_caches(user_id)

    if body.status != "approved":
        # Kill live sessions immediately — the refresh check alone would leave
        # the current access token working until it expires.
        try:
            db.table("refresh_tokens").delete().eq("user_id", user_id).execute()
        except Exception as e:
            logger.warning("Failed to revoke tokens for %s: %s", user_id, e)

    logger.info(
        "Approval %s for %s by admin %s", body.status, row.data["email"], admin["id"]
    )
    return {"id": user_id, "approval_status": body.status}


@router.get("/me")
def get_me(user: dict = Depends(get_current_user)):
    db = get_client()
    row = db.table("users").select("display_name, avatar_base64").eq("id", user["id"]).maybe_single().execute()
    extra = row.data if row and row.data else {}
    return {
        **user,
        "display_name": extra.get("display_name"),
        "avatar_base64": extra.get("avatar_base64"),
    }
