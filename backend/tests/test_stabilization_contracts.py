import unittest

from backend.bandwidth import copy_chunks_with_rate_limit

from backend.auth_contracts import (
    build_websocket_token_protocol,
    extract_websocket_protocol_token,
)
from backend.playback_contracts import (
    build_ws_progress_payload,
    resolve_qqmusic_cover_url,
)


class StabilizationContractTests(unittest.TestCase):
    def test_cached_download_writer_enforces_average_byte_rate(self):
        now = [10.0]
        sleeps = []
        output = bytearray()

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        transferred = copy_chunks_with_rate_limit(
            [b"a" * 100, b"b" * 100],
            output.extend,
            100,
            clock=lambda: now[0],
            sleep=sleep,
        )

        self.assertEqual(transferred, 200)
        self.assertEqual(len(output), 200)
        self.assertEqual(sleeps, [1.0, 1.0])

    def test_websocket_protocol_token_round_trip(self):
        protocol = build_websocket_token_protocol("令牌 token+/=")
        header = f"minerats-v1, {protocol}"

        self.assertEqual(
            extract_websocket_protocol_token(header),
            "令牌 token+/=",
        )

    def test_ws_progress_payload_includes_queue_identity(self):
        payload = build_ws_progress_payload(
            {
                "state": "playing",
                "current_time": 12.5,
                "duration": 180.0,
                "track_id": 42,
                "now_playing_title": "Song",
                "now_playing_artist": "Artist",
                "now_playing_album": "Album",
                "artwork_url": "https://example.test/cover.jpg",
            }
        )

        self.assertEqual(payload["song"]["track_id"], 42)
        self.assertEqual(payload["song"]["queue_id"], 42)

    def test_qqmusic_cover_prefers_explicit_url(self):
        explicit_cover = "https://example.test/cover.jpg"

        result = resolve_qqmusic_cover_url(
            cover_url=f"  {explicit_cover}  ",
            album_mid="album-mid",
            album_cover_resolver=lambda _: self.fail("fallback should not run"),
        )

        self.assertEqual(result, explicit_cover)

    def test_qqmusic_cover_falls_back_to_album_mid(self):
        result = resolve_qqmusic_cover_url(
            cover_url="",
            album_mid="album-mid",
            album_cover_resolver=lambda album_mid: f"https://example.test/{album_mid}.jpg",
        )

        self.assertEqual(result, "https://example.test/album-mid.jpg")


if __name__ == "__main__":
    unittest.main()
