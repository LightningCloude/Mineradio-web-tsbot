from __future__ import annotations

from collections.abc import Callable
from typing import Any


def resolve_qqmusic_cover_url(
    *,
    cover_url: str,
    album_mid: str,
    album_cover_resolver: Callable[[str], str],
) -> str:
    explicit_cover = (cover_url or "").strip()
    if explicit_cover:
        return explicit_cover
    if album_mid:
        return album_cover_resolver(album_mid)
    return ""


def build_ws_progress_payload(status: dict[str, Any]) -> dict[str, Any]:
    track_id = status.get("track_id")
    return {
        "type": "progress",
        "state": status["state"],
        "position": status["current_time"],
        "duration": status["duration"],
        "song": {
            "track_id": track_id,
            "queue_id": track_id,
            "title": status["now_playing_title"] or "",
            "artist": status["now_playing_artist"] or "",
            "album": status["now_playing_album"] or "",
            "cover": status["artwork_url"] or "",
            "duration": status["duration"],
            "bpm": 120,  # default; QQ Music API does not provide BPM
        } if status.get("now_playing_title") else None,
    }
