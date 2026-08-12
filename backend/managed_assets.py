from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import uuid


REPO_ROOT = Path(__file__).resolve().parent.parent


def _default_asset_dir() -> Path:
    configured = (os.getenv("TSBOT_ASSET_DIR") or "").strip()
    if configured:
        path = Path(configured)
        return path if path.is_absolute() else REPO_ROOT / path
    database_url = os.getenv("DATABASE_URL") or os.getenv("TSBOT_DATABASE_URL")
    if database_url and database_url.startswith("sqlite:///"):
        database_path = Path(database_url.removeprefix("sqlite:///"))
        if not database_path.is_absolute():
            database_path = REPO_ROOT / database_path
        return database_path.parent / "uploads"
    return REPO_ROOT / "data" / "uploads"


ASSET_DIR = _default_asset_dir()
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class ManagedAsset:
    key: str
    group: str
    label: str
    filename: str
    public_path: str = ""
    restart: str = "none"
    allow_ico: bool = False
    help: str = ""


ASSETS: tuple[ManagedAsset, ...] = (
    ManagedAsset(
        key="web-app-icon",
        group="web",
        label="界面图标",
        filename="web-app-icon",
        public_path="/assets/web-app-icon",
        allow_ico=True,
        help="用于浏览器标签页图标，固定保存到 data/uploads/web-app-icon。",
    ),
    ManagedAsset(
        key="teamspeak-avatar",
        group="teamspeak",
        label="机器人头像",
        filename="teamspeak-avatar",
        public_path="/assets/teamspeak-avatar",
        restart="voice",
        help="用于 TeamSpeak 客户端头像，固定保存到 data/uploads/teamspeak-avatar。",
    ),
)

ASSET_BY_KEY = {asset.key: asset for asset in ASSETS}


def asset_path(asset: ManagedAsset) -> Path:
    return ASSET_DIR / asset.filename


def voice_avatar_config_path() -> str:
    return str(asset_path(ASSET_BY_KEY["teamspeak-avatar"]))


def detect_image_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    return None


def validate_image(asset: ManagedAsset, data: bytes) -> str:
    if not data:
        raise ValueError("请选择图片文件")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片不能超过 5 MiB")
    media_type = detect_image_type(data)
    if media_type is None:
        raise ValueError("仅支持 PNG、JPEG、WebP 或 GIF 图片")
    if media_type == "image/x-icon" and not asset.allow_ico:
        raise ValueError("机器人头像不支持 ICO 文件")
    return media_type


def save_asset(asset: ManagedAsset, data: bytes) -> str:
    media_type = validate_image(asset, data)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    destination = asset_path(asset)
    temporary = ASSET_DIR / f".{asset.filename}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_bytes(data)
        os.chmod(temporary, 0o644)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return media_type


def delete_asset(asset: ManagedAsset) -> bool:
    path = asset_path(asset)
    existed = path.is_file()
    path.unlink(missing_ok=True)
    return existed


def asset_payload(asset: ManagedAsset) -> dict[str, object]:
    path = asset_path(asset)
    configured = path.is_file()
    version = path.stat().st_mtime_ns if configured else 0
    try:
        storage_path = str(path.relative_to(REPO_ROOT))
    except ValueError:
        storage_path = str(path)
    return {
        "key": asset.key,
        "group": asset.group,
        "label": asset.label,
        "configured": configured,
        "url": asset.public_path if configured else "",
        "version": version,
        "restart": asset.restart,
        "accept": "image/png,image/jpeg,image/webp,image/gif" + (",image/x-icon,.ico" if asset.allow_ico else ""),
        "max_size_mb": MAX_IMAGE_BYTES // (1024 * 1024),
        "storage_path": storage_path,
        "help": asset.help,
    }


def assets_payload() -> list[dict[str, object]]:
    return [asset_payload(asset) for asset in ASSETS]
