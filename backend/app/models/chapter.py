from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class ChapterResponse(BaseModel):
    id: str
    book_id: str
    chapter_index: int
    title: str
    word_count: int
    status: str
    error_message: Optional[str] = None
    created_at: datetime
    audio: Optional["AudioSummary"] = None


class AudioSummary(BaseModel):
    public_url: str
    duration_seconds: Optional[float] = None
    file_size_bytes: Optional[int] = None


class PaginatedChaptersResponse(BaseModel):
    items: List[ChapterResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


ChapterResponse.model_rebuild()
