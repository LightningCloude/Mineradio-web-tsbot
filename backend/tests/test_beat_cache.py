from __future__ import annotations

import unittest

from backend.beat_cache import normalize_song_name, sanitize_beat_analysis


class BeatCacheContractTests(unittest.TestCase):
    def test_song_names_use_unicode_case_and_whitespace_normalization(self):
        key, display = normalize_song_name("  Ｈｅｌｌｏ\n  WORLD  ")
        self.assertEqual(key, "hello world")
        self.assertEqual(display, "Hello WORLD")

    def test_analysis_payload_is_bounded_and_non_finite_values_are_removed(self):
        result = sanitize_beat_analysis({
            "gridStep": 0.5,
            "duration": 2,
            "beats": [{
                "time": 0,
                "type": "unknown",
                "strength": float("inf"),
                "sectionEnergy": 4,
            }],
        })
        self.assertEqual(result["beats"][0]["type"], "pulse")
        self.assertEqual(result["beats"][0]["strength"], 0)
        self.assertEqual(result["beats"][0]["sectionEnergy"], 1)

    def test_analysis_rejects_unsorted_times(self):
        with self.assertRaisesRegex(ValueError, "ordered"):
            sanitize_beat_analysis({
                "gridStep": 0.5,
                "beats": [{"time": 1}, {"time": 0.5}],
            })


if __name__ == "__main__":
    unittest.main()
