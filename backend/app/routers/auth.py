import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from jose import jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr

from app.config import settings
from app.database import get_client
from app.dependencies import get_current_user, _lookup_role

router = APIRouter(prefix="/api/auth", tags=["auth"])

_ALGORITHM = "HS256"
_ACCESS_TOKEN_EXPIRE_MINUTES = 60
_REFRESH_TOKEN_EXPIRE_DAYS = 90

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


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


@router.post("/signup", response_model=AuthResponse)
async def signup(body: AuthRequest):
    db = get_client()
    try:
        existing = db.table("users").select("id").eq("email", body.email).maybe_single().execute()
        if existing and existing.data:
            raise HTTPException(status_code=400, detail="Email đã được đăng ký")

        user_id = str(uuid.uuid4())
        password_hash = _pwd_context.hash(body.password)
        db.table("users").insert({
            "id": user_id,
            "email": body.email,
            "password_hash": password_hash,
        }).execute()

        access_token = _create_access_token(user_id, body.email)
        refresh_token = _create_refresh_token(user_id)
        return AuthResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user_id=user_id,
            email=body.email,
            role=_lookup_role(user_id),
        )
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e).lower()
        if "not found" in error_msg or "does not exist" in error_msg:
            raise HTTPException(status_code=500, detail="Database schema not initialized. Run the SQL migrations.")
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/update-profile")
async def update_profile(
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
async def login(body: AuthRequest):
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
        if not password_hash or not _pwd_context.verify(body.password, password_hash):
            raise HTTPException(status_code=401, detail="Email hoặc mật khẩu không đúng")

        user_id = user_data["id"]
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
        raise HTTPException(status_code=401, detail="Lỗi đăng nhập")


@router.post("/refresh", response_model=AuthResponse)
async def refresh(body: RefreshRequest):
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
        user_row = db.table("users").select("email, display_name, avatar_base64").eq("id", user_id).maybe_single().execute()
        if not user_row or not user_row.data:
            raise HTTPException(status_code=401, detail="User not found")

        u = user_row.data
        email = u["email"]
        # Rotate: revoke old token and issue a fresh one
        _revoke_refresh_token(body.refresh_token)
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
        raise HTTPException(status_code=401, detail="Token refresh failed")


@router.get("/me")
async def get_me(user: dict = Depends(get_current_user)):
    db = get_client()
    row = db.table("users").select("display_name, avatar_base64").eq("id", user["id"]).maybe_single().execute()
    extra = row.data if row and row.data else {}
    return {
        **user,
        "display_name": extra.get("display_name"),
        "avatar_base64": extra.get("avatar_base64"),
    }
