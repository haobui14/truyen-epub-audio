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
    # Latest Android APK version (semver). Bump the ANDROID_LATEST_VERSION env
    # var on Railway after distributing a new APK; installs running an older
    # NEXT_PUBLIC_APP_VERSION show an update notice. Optional download link
    # shown with the notice (e.g. a shared-drive URL).
    android_latest_version: str = "1.1.1"
    android_version_code: int = 1001001
    android_download_url: Optional[str] = None
    android_apk_sha256: Optional[str] = None
    android_min_supported_version: Optional[str] = None

    @property
    def cors_origins(self) -> list[str]:
        return [s.strip() for s in self.allowed_origins.split(",")]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
