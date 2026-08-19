from typing import Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_key: str
    jwt_secret: str
    allowed_origins: str = "http://localhost:3000"
    max_upload_size_mb: int = 50
    tts_voice_default: str = "vi-VN-HoaiMyNeural"
    openai_api_key: Optional[str] = None
    openai_model: str = "gpt-4.5"
    # Used only by scripts/translate_chapters_deepseek.py (offline tooling).
    deepseek_api_key: Optional[str] = None
    deepseek_model: str = "deepseek-chat"

    @property
    def cors_origins(self) -> list[str]:
        return [s.strip() for s in self.allowed_origins.split(",")]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
