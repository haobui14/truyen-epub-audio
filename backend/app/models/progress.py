from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ProgressUpsert(BaseModel):
    book_id: str
    chapter_id: str
    progress_type: str  # "read" or "listen"
    progress_value: float
    total_value: Optional[float] = None


class ProgressResponse(BaseModel):
    id: str
    user_id: str
    book_id: str
    chapter_id: str
    progress_type: str
    progress_value: float
    total_value: Optional[float] = None
    updated_at: datetime
