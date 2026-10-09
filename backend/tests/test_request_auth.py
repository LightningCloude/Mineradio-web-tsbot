import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend.tests.runtime_isolation import configure_test_runtime

configure_test_runtime()

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.websockets import WebSocket

from backend import main, request_auth
from backend.auth_contracts import build_websocket_token_protocol
from backend.config import settings


def _scope(kind="http", *, headers=(), path="/voice/pause", method="GET"):
    return {"type": kind, "path": path, "method": method, "headers": [(name.encode(), value.encode()) for name, value in headers], "scheme": "http", "server": ("testserver", 80), "query_string": b""}


class RequestAuthContractTests(unittest.TestCase):
    def test_main_keeps_existing_helper_aliases(self):
        for name in ("normalize_request_path", "get_request_api_token", "get_websocket_api_token", "websocket_subprotocol", "path_requires_api_token", "check_api_token"):
            self.assertIs(getattr(main, f"_{name}"), getattr(request_auth, name))

    def test_request_token_header_precedence_is_unchanged(self):
        request = Request(_scope(headers=(("authorization", "  bEaReR first  "), ("x-api-token", "second"))))
        self.assertEqual(request_auth.get_request_api_token(request), "first")
        request = Request(_scope(headers=(("authorization", "Basic ignored"), ("x-api-token", " second "))))
        self.assertEqual(request_auth.get_request_api_token(request), "second")

    def test_websocket_token_precedence_and_subprotocol_are_unchanged(self):
        protocol = build_websocket_token_protocol("protocol-token")
        headers = (("authorization", "Bearer bearer-token"), ("x-api-token", "header-token"), ("sec-websocket-protocol", f"{protocol}, minerats-v1"))
        for skip, expected in ((0, "bearer-token"), (1, "header-token"), (2, "protocol-token")):
            socket = WebSocket(_scope("websocket", headers=headers[skip:]), AsyncMock(), AsyncMock())
            self.assertEqual(request_auth.get_websocket_api_token(socket), expected)
            self.assertEqual(request_auth.websocket_subprotocol(socket), "minerats-v1")

    def test_explicit_compatibility_mode_has_no_token_gate(self):
        with patch.object(settings, "require_api_auth", False), patch.object(settings, "api_token", ""), patch.object(settings, "api_tokens", ""):
            for path in ("/queue", "/lyrics/1", "/voice/pause", "/external/status"):
                self.assertFalse(request_auth.path_requires_api_token(path), path)

    def test_configured_tokens_still_protect_routes_even_with_legacy_flag(self):
        with patch.object(settings, "require_api_auth", False), patch.object(settings, "api_token", "configured"), patch.object(settings, "api_tokens", ""):
            self.assertTrue(request_auth.path_requires_api_token("/voice/pause/"))
            for path in ("/", "/admin", "/admin/settings", "/docs/", "/auth/login", "/health/live", "/health/ready", "/assets/example", "/cover/example"):
                self.assertFalse(request_auth.path_requires_api_token(path), path)

    def test_multiple_tokens_and_missing_invalid_errors_are_preserved(self):
        with patch.object(settings, "api_token", "first"), patch.object(settings, "api_tokens", "second, third"):
            for token in ("first", "second", "third"):
                self.assertIsNone(request_auth.check_api_token(Request(_scope(headers=(("x-api-token", token),)))))
            self.assertEqual(request_auth.check_api_token(Request(_scope())), "missing api token")
            self.assertEqual(request_auth.check_api_token(Request(_scope(headers=(("authorization", "Bearer invalid"),)))), "invalid api token")

    def test_http_middleware_preserves_status_codes_options_and_compatibility(self):
        app = FastAPI()
        app.middleware("http")(request_auth.api_token_middleware)

        @app.api_route("/{path:path}", methods=["GET", "OPTIONS"])
        async def target(path: str):
            return {"ok": True}

        with TestClient(app) as client:
            with patch.object(settings, "require_api_auth", True), patch.object(settings, "api_token", ""), patch.object(settings, "api_tokens", ""):
                response = client.get("/voice/pause")
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.headers["www-authenticate"], "Bearer")
                self.assertEqual(client.options("/voice/pause").status_code, 200)
                self.assertEqual(client.get("/health/ready").status_code, 200)
            with patch.object(settings, "api_token", "valid"):
                self.assertEqual(client.get("/voice/pause").status_code, 401)
                self.assertEqual(client.get("/voice/pause", headers={"Authorization": "Bearer valid"}).status_code, 200)
            with patch.object(settings, "require_api_auth", False), patch.object(settings, "api_token", ""), patch.object(settings, "api_tokens", ""):
                self.assertEqual(client.get("/voice/pause").status_code, 200)


class RequestAuthDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def test_main_middleware_still_observes_existing_monkeypatch_points(self):
        request = Request(_scope())
        next_handler = AsyncMock(return_value="downstream")
        with patch.object(main, "_path_requires_api_token", Mock(return_value=False)) as policy, patch.object(main, "_check_api_token", Mock(return_value="invalid api token")) as token_check:
            self.assertEqual(await main.api_token_middleware(request, next_handler), "downstream")
        policy.assert_called_once_with("/voice/pause")
        token_check.assert_not_called()
        next_handler.assert_awaited_once_with(request)
