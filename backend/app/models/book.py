from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class GenreInBook(BaseModel):
    id: str
    name: str
    color: str


class BookResponse(BaseModel):
    id: str
    title: str
    author: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    voice: str
    status: str
    error_message: Optional[str] = None  # populated when status == 'error'
    total_chapters: int
    created_at: datetime
    genres: List[GenreInBook] = []
    is_featured: bool = False
    featured_label: Optional[str] = None
    story_status: str = "unknown"  # 'ongoing' | 'completed' | 'unknown'
    # When chapters were last ADDED (append/manual add) — drives the home
    # page's "Mới cập nhật" row. Null for books never updated since seeding.
    last_chapter_added_at: Optional[datetime] = None
