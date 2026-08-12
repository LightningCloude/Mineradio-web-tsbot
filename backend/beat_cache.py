from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import BeatAnalysisCache


MAX_BEATS = 12000
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
_SPACE_RE = re.compile(r"\s+")
_BEAT_TYPES = {"downbeat", "push", "drop", "rebound", "accent", "pulse"}
_UNIT_FIELDS = (
    "intensity",
    "strength",
    "confidence",
    "low",
    "body",
    "snap",
    "mass",
    "sharpness",
    "impact",
    "sectionEnergy",
)


def normalize_song_name(name: str) -> tuple[str, str]:
    display = _SPACE_RE.sub(" ", unicodedata.normalize("NFKC", str(name or ""))).strip()
    if not display:
        raise ValueError("song name is required")
    if len(display) > 255:
        raise ValueError("song name is too long")
    return display.casefold(), display


def _finite_number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _unit(value: Any) -> float:
    return max(0.0, min(1.0, _finite_number(value)))


def sanitize_beat_analysis(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ValueError("analysis result must be an object")
    raw_beats = result.get("beats")
    if not isinstance(raw_beats, list) or not raw_beats:
        raise ValueError("analysis result must contain beats")
    if len(raw_beats) > MAX_BEATS:
        raise ValueError("analysis result contains too many beats")

    beats: list[dict[str, Any]] = []
    previous_time = -1.0
    for raw in raw_beats:
        if not isinstance(raw, dict):
            raise ValueError("beat entries must be objects")
        beat_time = _finite_number(raw.get("time"), -1.0)
        if beat_time < 0 or beat_time > 86400 or beat_time < previous_time:
            raise ValueError("beat times must be ordered and in range")
        previous_time = beat_time
        beat_type = str(raw.get("type") or "pulse").strip().lower()
        if beat_type not in _BEAT_TYPES:
            beat_type = "pulse"
        beat: dict[str, Any] = {"time": beat_time, "type": beat_type, "offline": True}
        for field in _UNIT_FIELDS:
            beat[field] = _unit(raw.get(field))
        beats.append(beat)

    grid_step = _finite_number(result.get("gridStep"), 0.0)
    if grid_step < 0.1 or grid_step > 2.0:
        raise ValueError("gridStep is outside the supported range")
    duration = max(previous_time, min(86400.0, _finite_number(result.get("duration"))))
    sanitized = {
        "beats": beats,
        "gridStep": grid_step,
        "duration": duration,
        "beatCount": len(beats),
    }
    encoded = json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValueError("analysis result is too large")
    return sanitized


def get_cached_analysis(session: Session, song_name: str) -> tuple[BeatAnalysisCache | None, dict[str, Any] | None]:
    song_key, _ = normalize_song_name(song_name)
    row = session.get(BeatAnalysisCache, song_key)
    if row is None:
        return None, None
    try:
        payload = json.loads(row.payload)
    except (TypeError, json.JSONDecodeError):
        return None, None
    return row, payload


def store_cached_analysis(
    session: Session,
    song_name: str,
    result: Any,
) -> tuple[BeatAnalysisCache, dict[str, Any], bool]:
    song_key, display_name = normalize_song_name(song_name)
    existing, existing_payload = get_cached_analysis(session, display_name)
    if existing is not None and existing_payload is not None:
        return existing, existing_payload, False

    sanitized = sanitize_beat_analysis(result)
    payload = json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    checksum = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    row = BeatAnalysisCache(
        song_key=song_key,
        song_name=display_name,
        payload=payload,
        checksum=checksum,
    )
    session.add(row)
    try:
        session.commit()
        session.refresh(row)
        return row, sanitized, True
    except IntegrityError:
        # A concurrent user won the unique-key insert. Preserve and return the
        # first shared result instead of overwriting or storing a duplicate.
        session.rollback()
        winner, winner_payload = get_cached_analysis(session, display_name)
        if winner is None or winner_payload is None:
            raise
        return winner, winner_payload, False
