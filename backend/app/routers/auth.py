from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr

from app.database import get_client
from app.dependencies import get_current_user, _lookup_role

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthRequest(BaseModel):
    email: EmailStr
    password: str


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str = ""
    user_id: str
    email: str
    role: str = "user"


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/signup", response_model=AuthResponse)
async def signup(body: AuthRequest):
    db = get_client()
    try:
        result = db.auth.sign_up(
            {"email": body.email, "password": body.password}
        )
        if not result.session:
            raise HTTPException(
                status_code=400,
                detail="Signup failed. Check if email confirmation is disabled in Supabase settings.",
            )
        user_id = str(result.user.id)
        return AuthResponse(
            access_token=result.session.access_token,
            refresh_token=result.session.refresh_token or "",
            user_id=user_id,
            email=result.user.email,
            role=_lookup_role(user_id),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login", response_model=AuthResponse)
async def login(body: AuthRequest):
    db = get_client()
    try:
        result = db.auth.sign_in_with_password(
            {"email": body.email, "password": body.password}
        )
        user_id = str(result.user.id)
        return AuthResponse(
            access_token=result.session.access_token,
            refresh_token=result.session.refresh_token or "",
            user_id=user_id,
            email=result.user.email,
            role=_lookup_role(user_id),
        )
    except Exception:
        raise HTTPException(status_code=401, detail="Email hoặc mật khẩu không đúng")


@router.post("/refresh", response_model=AuthResponse)
async def refresh_token(body: RefreshRequest):
    db = get_client()
    try:
        result = db.auth.refresh_session(body.refresh_token)
        if not result or not result.session:
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
        user_id = str(result.user.id)
        return AuthResponse(
            access_token=result.session.access_token,
            refresh_token=result.session.refresh_token or "",
            user_id=user_id,
            email=result.user.email,
            role=_lookup_role(user_id),
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Token refresh failed")


@router.get("/me")
async def get_me(user: dict = Depends(get_current_user)):
    return user
