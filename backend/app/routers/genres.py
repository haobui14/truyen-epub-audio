from fastapi import APIRouter, Depends, HTTPException
from typing import List

from app.database import get_client
from app.dependencies import get_admin_user, get_current_user
from app.models.genre import GenreResponse, GenreCreate, GenreUpdate

router = APIRouter(prefix="/api/genres", tags=["genres"])

VALID_COLORS = {
    "indigo", "purple", "pink", "rose", "red", "orange",
    "amber", "yellow", "green", "teal", "cyan", "blue", "gray",
}


def _validate_color(color: str) -> str:
    color = color.lower().strip()
    if color not in VALID_COLORS:
        raise HTTPException(status_code=400, detail=f"Invalid color. Choose from: {', '.join(sorted(VALID_COLORS))}")
    return color


@router.get("", response_model=List[GenreResponse])
async def list_genres(_user: dict = Depends(get_current_user)):
    """List all genres. Accessible to any authenticated user (read-only)."""
    db = get_client()
    result = (
        db.table("genres")
        .select("id,name,color,created_at")
        .order("name")
        .execute()
    )
    return result.data


@router.post("", response_model=GenreResponse, status_code=201)
async def create_genre(body: GenreCreate, _admin: dict = Depends(get_admin_user)):
    color = _validate_color(body.color)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Genre name cannot be empty")
    if len(name) > 50:
        raise HTTPException(status_code=400, detail="Genre name too long (max 50 chars)")

    db = get_client()
    try:
        result = (
            db.table("genres")
            .insert({"name": name, "color": color})
            .execute()
        )
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="Genre with this name already exists")
        raise HTTPException(status_code=500, detail="Failed to create genre")

    return result.data[0]


@router.patch("/{genre_id}", response_model=GenreResponse)
async def update_genre(genre_id: str, body: GenreUpdate, _admin: dict = Depends(get_admin_user)):
    db = get_client()
    existing = db.table("genres").select("id").eq("id", genre_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Genre not found")

    updates: dict = {}
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Genre name cannot be empty")
        if len(name) > 50:
            raise HTTPException(status_code=400, detail="Genre name too long (max 50 chars)")
        updates["name"] = name
    if body.color is not None:
        updates["color"] = _validate_color(body.color)

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    try:
        result = db.table("genres").update(updates).eq("id", genre_id).execute()
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="Genre with this name already exists")
        raise HTTPException(status_code=500, detail="Failed to update genre")

    return result.data[0]


@router.delete("/{genre_id}", status_code=204)
async def delete_genre(genre_id: str, _admin: dict = Depends(get_admin_user)):
    db = get_client()
    existing = db.table("genres").select("id").eq("id", genre_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Genre not found")

    db.table("genres").delete().eq("id", genre_id).execute()


# ── Book ↔ Genre assignment (admin only) ──

@router.post("/assign/{book_id}/{genre_id}", status_code=204)
async def assign_genre(book_id: str, genre_id: str, _admin: dict = Depends(get_admin_user)):
    db = get_client()
    book = db.table("books").select("id").eq("id", book_id).single().execute()
    if not book.data:
        raise HTTPException(status_code=404, detail="Book not found")
    genre = db.table("genres").select("id").eq("id", genre_id).single().execute()
    if not genre.data:
        raise HTTPException(status_code=404, detail="Genre not found")

    db.table("book_genres").upsert({"book_id": book_id, "genre_id": genre_id}).execute()


@router.delete("/assign/{book_id}/{genre_id}", status_code=204)
async def remove_genre(book_id: str, genre_id: str, _admin: dict = Depends(get_admin_user)):
    db = get_client()
    db.table("book_genres").delete().eq("book_id", book_id).eq("genre_id", genre_id).execute()
