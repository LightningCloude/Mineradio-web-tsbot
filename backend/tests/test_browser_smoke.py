from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "browser_smoke.py"
SPEC = importlib.util.spec_from_file_location("browser_smoke", SCRIPT_PATH)
assert SPEC and SPEC.loader
browser_smoke = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = browser_smoke
SPEC.loader.exec_module(browser_smoke)


def args(**overrides):
    values = {
        "mode": "readonly",
        "allow_state_changes": False,
        "remote_confirmation": "",
        "search_query": "test",
        "exercise_playback": False,
        "isolated_playback_confirmation": "",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class BrowserSmokePolicyTests(unittest.TestCase):
    def test_readonly_mode_accepts_remote_urls(self):
        browser_smoke.validate_mutation_policy(
            args(),
            "https://music.example.com",
        )

    def test_stateful_mode_requires_explicit_permission(self):
        with self.assertRaisesRegex(ValueError, "allow-state-changes"):
            browser_smoke.validate_mutation_policy(
                args(mode="stateful"),
                "http://127.0.0.1:8080",
            )

    def test_remote_stateful_mode_requires_exact_confirmation(self):
        with self.assertRaisesRegex(ValueError, "remote-confirmation"):
            browser_smoke.validate_mutation_policy(
                args(mode="stateful", allow_state_changes=True),
                "https://music.example.com",
            )
        browser_smoke.validate_mutation_policy(
            args(
                mode="stateful",
                allow_state_changes=True,
                remote_confirmation=browser_smoke.REMOTE_CONFIRMATION,
            ),
            "https://music.example.com",
        )

    def test_playback_exercise_is_loopback_and_isolation_guarded(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            browser_smoke.validate_mutation_policy(
                args(
                    mode="stateful",
                    allow_state_changes=True,
                    remote_confirmation=browser_smoke.REMOTE_CONFIRMATION,
                    exercise_playback=True,
                ),
                "https://music.example.com",
            )
        with self.assertRaisesRegex(ValueError, "isolated-playback-confirmation"):
            browser_smoke.validate_mutation_policy(
                args(
                    mode="stateful",
                    allow_state_changes=True,
                    exercise_playback=True,
                ),
                "http://localhost:8080",
            )

    def test_playback_exercise_accepts_explicit_isolated_loopback(self):
        browser_smoke.validate_mutation_policy(
            args(
                mode="stateful",
                allow_state_changes=True,
                exercise_playback=True,
                isolated_playback_confirmation=(
                    browser_smoke.ISOLATED_PLAYBACK_CONFIRMATION
                ),
            ),
            "http://127.0.0.1:8080",
        )

    def test_only_application_critical_request_types_fail_the_run(self):
        for resource_type in ("document", "script", "stylesheet", "xhr", "fetch"):
            with self.subTest(resource_type=resource_type):
                self.assertTrue(
                    browser_smoke.critical_request_failure(resource_type)
                )
        for resource_type in ("image", "media", "font"):
            with self.subTest(resource_type=resource_type):
                self.assertFalse(
                    browser_smoke.critical_request_failure(resource_type)
                )

    def test_navigation_aborts_are_not_reported_as_network_failures(self):
        self.assertTrue(browser_smoke.benign_request_failure("net::ERR_ABORTED"))
        self.assertFalse(browser_smoke.benign_request_failure("net::ERR_TIMED_OUT"))

    def test_resource_console_noise_is_classified_by_network_checks(self):
        self.assertTrue(
            browser_smoke.benign_console_error(
                "Failed to load resource: net::ERR_FAILED"
            )
        )
        self.assertTrue(
            browser_smoke.benign_console_error(
                "Access to image at 'https://y.gtimg.cn/x' has been blocked "
                "by CORS policy"
            )
        )
        self.assertFalse(browser_smoke.benign_console_error("application crashed"))

    def test_detects_qq_covers_that_bypass_the_same_origin_proxy(self):
        self.assertTrue(
            browser_smoke.is_direct_qq_cover_request(
                "https://y.gtimg.cn/music/photo_new/T002R300.jpg"
            )
        )
        self.assertFalse(
            browser_smoke.is_direct_qq_cover_request(
                "http://127.0.0.1:8080/cover/T002R300.jpg"
            )
        )
        self.assertTrue(
            browser_smoke.valid_cover_proxy_response(200, "image/jpeg")
        )
        self.assertFalse(
            browser_smoke.valid_cover_proxy_response(200, "text/html")
        )
        self.assertFalse(
            browser_smoke.valid_cover_proxy_response(502, "text/plain")
        )

    def test_api_token_init_script_escapes_multiline_tokens(self):
        script = browser_smoke.api_token_init_script("line1\n'line2")
        self.assertIn(r"\n", script)
        self.assertIn("'line2", script)
        self.assertNotIn("line1\n", script)


if __name__ == "__main__":
    unittest.main()
