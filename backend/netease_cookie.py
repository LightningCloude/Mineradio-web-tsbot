from __future__ import annotations

import re


_NETEASE_COOKIE_KEYS = {
    "music_r_t",
    "music_a_t",
    "music_r_u",
    "music_sns",
    "nmtid",
    "__csrf",
    "music_u",
}
_NETEASE_CORE_COOKIE_KEYS = {"music_u", "music_r_u"}
_COOKIE_PAIR_RE = re.compile(r"([^;\s=]+)\s*=\s*([^;]*)")


def extract_netease_auth_cookie(raw_cookie: str) -> str:
    values: dict[str, tuple[str, str]] = {}
    for key, value in _COOKIE_PAIR_RE.findall(str(raw_cookie or "")):
        original_key = key.strip()
        normalized_key = original_key.lower()
        cleaned_value = value.strip()
        if normalized_key not in _NETEASE_COOKIE_KEYS or not cleaned_value:
            continue
        values[normalized_key] = (original_key, cleaned_value)

    if not _NETEASE_CORE_COOKIE_KEYS.intersection(values):
        return ""
    return "; ".join(f"{key}={value}" for key, value in values.values())


def has_netease_auth_cookie(raw_cookie: str) -> bool:
    return bool(extract_netease_auth_cookie(raw_cookie))
