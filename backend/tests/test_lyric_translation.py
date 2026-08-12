from __future__ import annotations

from pathlib import Path
import unittest

from backend.lyric_translation import align_native_translations


class LyricTranslationTests(unittest.TestCase):
    def test_netease_branch_ignores_provider_translation_fields(self):
        source = (Path(__file__).resolve().parents[1] / "main.py").read_text(
            encoding="utf-8"
        )
        branch = source.split('if track_id.startswith("netease:")', 1)[1].split(
            'elif track_id.startswith("qqmusic:")', 1
        )[0]

        self.assertNotIn('get("tlyric")', branch)
        self.assertNotIn('get("ytlrc")', branch)
        self.assertIn("_parse_lrc_to_lines", branch)

    def test_attaches_small_timestamp_offsets(self):
        aligned = align_native_translations(
            [(1.0, "Hello"), (5.0, "World")],
            [(1.18, "你好"), (4.82, "世界")],
        )
        self.assertEqual(aligned, ["你好", "世界"])

    def test_does_not_cross_match_distant_lines(self):
        aligned = align_native_translations(
            [(1.0, "Hello"), (5.0, "World")],
            [(9.0, "不应匹配")],
        )
        self.assertEqual(aligned, ["", ""])

    def test_suppresses_duplicate_and_empty_translations(self):
        aligned = align_native_translations(
            [(1.0, "Same text"), (5.0, "Next")],
            [(1.0, "Same text"), (5.0, "   ")],
        )
        self.assertEqual(aligned, ["", ""])

    def test_suppresses_qq_copyright_notice_and_slash_placeholders(self):
        aligned = align_native_translations(
            [(0.0, "Title"), (2.0, "Credits"), (4.0, "Lyric")],
            [
                (0.0, "QQ音乐享有本翻译作品的著作权"),
                (2.0, "//"),
                (4.0, "正文译文"),
            ],
        )
        self.assertEqual(aligned, ["", "", "正文译文"])

    def test_each_translation_is_used_at_most_once(self):
        aligned = align_native_translations(
            [(1.0, "A"), (1.2, "B")],
            [(1.1, "译文")],
        )
        self.assertEqual(aligned.count("译文"), 1)


if __name__ == "__main__":
    unittest.main()
