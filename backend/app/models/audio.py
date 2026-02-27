from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class AudioFileResponse(BaseModel):
    id: str
    chapter_id: str
    book_id: str
    public_url: str
    file_size_bytes: Optional[int] = None
    duration_seconds: Optional[float] = None
    voice: str
    created_at: datetime
