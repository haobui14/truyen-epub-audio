from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class BookResponse(BaseModel):
    id: str
    title: str
    author: Optional[str] = None
    cover_url: Optional[str] = None
    voice: str
    status: str
    total_chapters: int
    created_at: datetime
