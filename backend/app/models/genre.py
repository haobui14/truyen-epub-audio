from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class GenreResponse(BaseModel):
    id: str
    name: str
    color: str
    created_at: datetime


class GenreCreate(BaseModel):
    name: str
    color: str = "indigo"


class GenreUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
