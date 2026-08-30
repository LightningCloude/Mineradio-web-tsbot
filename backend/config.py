import re
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="TSBOT_",
        env_file=str(Path(__file__).resolve().parent / ".env"),
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8009
    voice_grpc_addr: str = "127.0.0.1:50051"
    cors_origins: str = ""
    
    cookie_key: str = "dev-cookie-key"
    netease_api_base: str = "http://127.0.0.1:3000/"
    
    # 日志配置
    log_level: str = "INFO"
    log_file: str = "logs/backend.log"

    api_token: str = ""
    api_tokens: str = ""
    require_api_auth: bool = True

    admin_token: str = ""
    # Keep the secure default for normal deployments. A trusted private
    # deployment can explicitly set this false for legacy browser clients.
    require_admin_auth: bool = True
    initial_admin_password: str = ""
    initial_password_file: str = "./logs/initial-admin-password.txt"
    voice_config_file: str = "./logs/voice-service.json"
    web_app_name: str = "Yumi TSBot"
    web_app_icon: str = ""
    web_log_level: str = "INFO"
    voice_description_title: str = "Yumi TSBot"
    voice_description_intro: str = "TeamSpeak 音乐机器人\\n支持网易云 / QQ 音乐 / B站"
    bilibili_max_duration_minutes: int = 180
    bilibili_audio_cache_ttl_hours: int = 72
    bilibili_audio_cache_max_mb: int = 2048
    bilibili_audio_partial_ttl_minutes: int = 60
    # Cached media downloads are background work and must not compete with
    # playback traffic. Values are intentionally conservative by default.
    bilibili_download_rate_kbps: int = 512
    bilibili_download_concurrency: int = 1

    def get_api_tokens(self) -> list[str]:
        tokens: list[str] = []
        for raw in (self.api_token, self.api_tokens):
            for part in re.split(r"[\s,]+", raw or ""):
                token = part.strip()
                if token and token not in tokens:
                    tokens.append(token)
        return tokens

    def get_cors_origins(self) -> list[str]:
        return [
            origin.strip().rstrip("/")
            for origin in re.split(r"[\s,]+", self.cors_origins or "")
            if origin.strip()
        ]

    def validate_security(self) -> None:
        if not self.cookie_key or self.cookie_key == "dev-cookie-key" or len(self.cookie_key) < 32:
            raise RuntimeError("TSBOT_COOKIE_KEY must be set to a unique value of at least 32 characters")
        if self.require_api_auth and not self.get_api_tokens():
            raise RuntimeError(
                "TSBOT_REQUIRE_API_AUTH is enabled but TSBOT_API_TOKEN(S) is not configured"
            )


settings = Settings()
