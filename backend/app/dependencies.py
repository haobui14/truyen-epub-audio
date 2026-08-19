from typing import Optional

from fastapi import Header, HTTPException
from jose import JWTError, jwt

from app.config import settings
from app.database import get_client

_ALGORITHM = "HS256"


def _lookup_role(user_id: str) -> str:
    """Return 'admin' or 'user' for the given user_id."""
    try:
        db = get_client()
        result = (
            db.table("user_roles")
            .select("role")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if result and result.data and "role" in result.data:
            return result.data["role"]
    except Exception:
        pass  # Fall through to default
    return "user"


PENDING_MESSAGE = (
    "Tài khoản của bạn đang chờ quản trị viên duyệt. "
    "Bạn sẽ đăng nhập được ngay khi được duyệt."
)
REJECTED_MESSAGE = "Tài khoản của bạn không được duyệt."


def lookup_approval(user_id: str) -> str:
    """Return 'approved' | 'pending' | 'rejected' for a user.

    Fails OPEN (returns 'approved') when the column or the row can't be read.
    Schema changes reach Supabase by hand in this project, so a backend deploy
    that lands before the migration must not lock every existing reader out of
    the app; the gate starts biting once the column exists.
    """
    try:
        db = get_client()
        result = (
            db.table("users")
            .select("approval_status")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
        if result and result.data:
            return result.data.get("approval_status") or "approved"
    except Exception:
        pass
    return "approved"


async def get_current_user(authorization: str = Header(...)) -> dict:
    """Extract and validate JWT from Authorization header. Returns {id, email, role}."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]
    try:
        # leeway (seconds) tolerates minor clock skew between this API server and
        # the issuer/client so a token that's a few seconds past exp by the
        # server clock isn't rejected — which would force an unnecessary refresh
        # round-trip (and a logout if that refresh then fails on a cold start).
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[_ALGORITHM],
            options={"leeway": 30},
        )
        user_id: str = payload.get("sub")
        email: str = payload.get("email", "")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        role = _lookup_role(user_id)
        return {"id": user_id, "email": email, "role": role}
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


async def get_admin_user(authorization: str = Header(...)) -> dict:
    """Same as get_current_user but raises 403 if the user is not an admin."""
    user = await get_current_user(authorization)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def get_approved_user(
    authorization: Optional[str] = Header(None),
) -> dict:
    """Gate for reading/listening: signed in AND approved by an admin.

    Header(None) rather than Header(...) so a request with no credentials gets
    a 401 the clients already know how to handle, instead of FastAPI's 422.
    Admins are exempt — an admin account is by definition already trusted, and
    locking one out would remove the only way to approve anybody.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Cần đăng nhập để đọc hoặc nghe truyện")
    user = await get_current_user(authorization)
    if user.get("role") == "admin":
        return user
    status = lookup_approval(user["id"])
    if status == "pending":
        raise HTTPException(status_code=403, detail=PENDING_MESSAGE)
    if status != "approved":
        raise HTTPException(status_code=403, detail=REJECTED_MESSAGE)
    return user


async def get_optional_user(
    authorization: Optional[str] = Header(None),
) -> Optional[dict]:
    """Same as get_current_user but returns None if no auth header."""
    if not authorization:
        return None
    try:
        return await get_current_user(authorization)
    except HTTPException:
        return None
