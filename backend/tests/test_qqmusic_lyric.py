from __future__ import annotations

import base64
import json
import unittest
from unittest.mock import AsyncMock

from backend.qqmusic import QQMusicClient, _decode_qq_lyric_text


def encoded(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


class QQMusicLyricTests(unittest.IsolatedAsyncioTestCase):
    def test_decodes_base64_and_plain_lrc(self):
        lrc = "[00:01.00]Hello &amp; goodbye"
        self.assertEqual(_decode_qq_lyric_text(encoded(lrc)), "[00:01.00]Hello & goodbye")
        self.assertEqual(_decode_qq_lyric_text(lrc), "[00:01.00]Hello & goodbye")

    async def test_primary_request_explicitly_asks_for_translation(self):
        client = QQMusicClient()
        client._post = AsyncMock(
            return_value={
                "lyric": {
                    "code": 0,
                    "data": {
                        "lyric": encoded("[00:01.00]Hello"),
                        "trans": encoded("[00:01.00]你好"),
                    },
                }
            }
        )
        client._get = AsyncMock()

        result = await client.get_song_lyric("song-mid")

        request_body = json.loads(client._post.await_args.args[1])
        params = request_body["lyric"]["param"]
        self.assertEqual(params["songMID"], "song-mid")
        self.assertEqual(params["trans"], 1)
        self.assertEqual(params["trans_t"], 0)
        self.assertEqual(result["lyric"], "[00:01.00]Hello")
        self.assertEqual(result["trans"], "[00:01.00]你好")
        client._get.assert_not_awaited()

    async def test_legacy_endpoint_remains_an_original_lyric_fallback(self):
        client = QQMusicClient()
        client._post = AsyncMock(side_effect=RuntimeError("primary unavailable"))
        client._get = AsyncMock(return_value={"lyric": "[00:01.00]Fallback"})

        result = await client.get_song_lyric("song-mid")

        self.assertEqual(result["lyric"], "[00:01.00]Fallback")
        self.assertEqual(result["trans"], "")
        self.assertIn("platform=yqq.json", client._get.await_args.args[0])


if __name__ == "__main__":
    unittest.main()
