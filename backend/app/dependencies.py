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


async def get_current_user(authorization: str = Header(...)) -> dict:
    """Extract and validate JWT from Authorization header. Returns {id, email, role}."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
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
