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
    total_chapters: int
    created_at: datetime
    genres: List[GenreInBook] = []
