from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_deployment.py"
SPEC = importlib.util.spec_from_file_location("verify_deployment", SCRIPT_PATH)
assert SPEC and SPEC.loader
verify_deployment = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verify_deployment
SPEC.loader.exec_module(verify_deployment)


class DeploymentVerifierUnitTests(unittest.TestCase):
    def test_normalizes_base_url_and_rejects_unsafe_shapes(self):
        self.assertEqual(
            verify_deployment.normalize_base_url(" https://music.example.com/ "),
            "https://music.example.com",
        )
        for value in ("music.example.com", "ftp://music.example.com", "https://x/#part"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    verify_deployment.normalize_base_url(value)

    def test_extracts_only_same_origin_scripts_and_stylesheets(self):
        html = b"""
        <html><head>
          <link rel="stylesheet" href="/assets/app.css">
          <link rel="icon" href="/favicon.ico">
          <script src="/assets/app.js"></script>
          <script src="https://cdn.example.com/vendor.js"></script>
        </head></html>
        """
        self.assertEqual(
            verify_deployment.extract_local_assets(
                "https://music.example.com/index.html",
                html,
            ),
            [
                "https://music.example.com/assets/app.css",
                "https://music.example.com/assets/app.js",
            ],
        )

    def test_websocket_token_protocol_matches_frontend_contract(self):
        protocols = verify_deployment.websocket_protocols("令牌 token+/=")
        self.assertEqual(protocols[0], "minerats-v1")
        self.assertEqual(
            protocols[1],
            "minerats-token.5Luk54mMIHRva2VuKy89",
        )
        self.assertEqual(verify_deployment.websocket_protocols(""), [])

    def test_websocket_request_preserves_base_path_and_hides_token(self):
        host, port, request, _ = verify_deployment.websocket_request(
            "https://music.example.com/tsbot",
            "secret-token",
        )
        text = request.decode("ascii")
        self.assertEqual(host, "music.example.com")
        self.assertEqual(port, 443)
        self.assertIn("GET /tsbot/ws/status HTTP/1.1", text)
        self.assertIn("Sec-WebSocket-Protocol: minerats-v1, minerats-token.", text)
        self.assertNotIn("secret-token", text)

    def test_required_openapi_paths_cover_public_and_admin_proxies(self):
        self.assertIn("/external/status", verify_deployment.REQUIRED_OPENAPI_PATHS)
        self.assertIn("/admin/status", verify_deployment.REQUIRED_OPENAPI_PATHS)

    def test_browser_smoke_invocation_passes_token_only_via_environment(self):
        command, environment = verify_deployment.browser_smoke_invocation(
            "https://music.example.com",
            8.0,
            "secret-token",
            False,
            "chromium",
        )
        self.assertIn("--json", command)
        self.assertIn("--browser", command)
        self.assertNotIn("secret-token", command)
        self.assertEqual(environment["TSBOT_API_TOKEN"], "secret-token")


if __name__ == "__main__":
    unittest.main()
