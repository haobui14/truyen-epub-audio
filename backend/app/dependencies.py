from typing import Optional

from fastapi import Header, HTTPException

from app.database import get_client


def _lookup_role(user_id: str) -> str:
    """Return 'admin' or 'user' for the given user_id."""
    db = get_client()
    result = (
        db.table("user_roles")
        .select("role")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    return result.data["role"] if result.data else "user"


async def get_current_user(authorization: str = Header(...)) -> dict:
    """Extract and validate JWT from Authorization header. Returns {id, email, role}."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]
    db = get_client()
    try:
        user_response = db.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = str(user_response.user.id)
        role = _lookup_role(user_id)
        return {"id": user_id, "email": user_response.user.email, "role": role}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


async def get_admin_user(authorization: str = Header(...)) -> dict:
    """Same as get_current_user but raises 403 if the user is not an admin."""
    user = await get_current_user(authorization)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
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
