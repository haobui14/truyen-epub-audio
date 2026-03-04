from datetime import datetime

from pydantic import BaseModel


class SettingsUpsert(BaseModel):
    playback_rate: float = 1
    playback_pitch: float = 1


class SettingsResponse(BaseModel):
    user_id: str
    playback_rate: float
    playback_pitch: float
    updated_at: datetime
