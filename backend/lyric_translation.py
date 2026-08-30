from __future__ import annotations

from collections.abc import Sequence


_QQ_TRANSLATION_NOTICE_MARKERS = (
    "QQ音乐享有本翻译作品的著作权",
    "QQ音樂享有本翻譯作品的著作權",
)


def _clean_native_translation(text: str) -> str:
    cleaned = text.strip()
    if not cleaned or not cleaned.replace("/", "").strip():
        return ""
    compact = "".join(cleaned.split())
    if any(marker in compact for marker in _QQ_TRANSLATION_NOTICE_MARKERS):
        return ""
    return cleaned


def align_native_translations(
    lyrics: Sequence[tuple[float, str]],
    translations: Sequence[tuple[float, str]],
) -> list[str]:
    """Return one safely timestamp-matched translation for each lyric line."""
    aligned = ["" for _ in lyrics]
    unused = set(range(len(translations)))

    for index, (lyric_time, lyric_text) in enumerate(lyrics):
        if not unused:
            break

        previous_gap = lyric_time - lyrics[index - 1][0] if index > 0 else 4.0
        next_gap = lyrics[index + 1][0] - lyric_time if index + 1 < len(lyrics) else previous_gap
        local_gap = max(0.0, min(previous_gap, next_gap))
        tolerance = max(0.55, min(1.5, local_gap * 0.35))

        nearest = min(
            unused,
            key=lambda candidate: abs(translations[candidate][0] - lyric_time),
        )
        translated_time, translated_text = translations[nearest]
        if abs(translated_time - lyric_time) > tolerance:
            continue

        unused.remove(nearest)
        text = _clean_native_translation(translated_text)
        if text and text != lyric_text.strip():
            aligned[index] = text

    return aligned
