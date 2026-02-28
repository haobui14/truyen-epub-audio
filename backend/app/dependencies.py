from typing import Optional

from fastapi import Header, HTTPException

from app.database import get_client


async def get_current_user(authorization: str = Header(...)) -> dict:
    """Extract and validate JWT from Authorization header."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]
    db = get_client()
    try:
        user_response = db.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        return {"id": str(user_response.user.id), "email": user_response.user.email}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


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
