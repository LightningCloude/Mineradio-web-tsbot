from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from backend.tests.runtime_isolation import configure_test_runtime


_IMPORT_ERROR: ModuleNotFoundError | None = None
_TEST_RUNTIME = configure_test_runtime()
_TEST_DB_PATH = _TEST_RUNTIME / "tsbot.db"
_WORKSPACE = Path(__file__).resolve().parents[2]


def _workspace_runtime_snapshot():
    paths = [_WORKSPACE / name for name in ("tsbot.db", "tsbot.env", "backend/.env")]
    for folder in ("logs", "data/uploads"):
        root = _WORKSPACE / folder
        if root.exists():
            paths.extend(path for path in root.rglob("*") if path.is_file())
    return {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()}


_IMPORT_SNAPSHOT = _workspace_runtime_snapshot()

try:
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from backend.auth_contracts import build_websocket_token_protocol
    from backend import db, main
except ModuleNotFoundError as exc:
    _IMPORT_ERROR = exc
    TestClient = None
    db = None
    main = None


@unittest.skipIf(main is None, f"backend runtime dependencies unavailable: {_IMPORT_ERROR}")
class ApiRouteIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if _workspace_runtime_snapshot() != _IMPORT_SNAPSHOT:
            raise AssertionError("Backend test imports changed workspace runtime files")
        if _TEST_DB_PATH.exists():
            _TEST_DB_PATH.unlink()
        main.create_db_and_tables()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        db._engine.dispose()
        if _TEST_DB_PATH.exists():
            _TEST_DB_PATH.unlink()
        if _workspace_runtime_snapshot() != _IMPORT_SNAPSHOT:
            raise AssertionError("API tests changed workspace runtime files")

    def test_admin_bootstrap_files_are_isolated_from_workspace(self):
        from backend import managed_assets

        for value in (main.settings.log_file, main.settings.initial_password_file, main.settings.voice_config_file):
            self.assertTrue(Path(value).is_relative_to(_TEST_RUNTIME))
        self.assertTrue(managed_assets.ASSET_DIR.is_relative_to(_TEST_RUNTIME))
        with patch.object(main.settings, "require_admin_auth", False):
            response = self.client.get("/admin/settings")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(Path(main.settings.initial_password_file).is_file())
        self.assertEqual(_workspace_runtime_snapshot(), _IMPORT_SNAPSHOT)

    def test_qr_key_route_requires_api_token_and_returns_session_fields(self):
        response = self.client.get("/qqmusic/login/qr/key")
        self.assertEqual(response.status_code, 401)

        qr_payload = {
            "qr_url": "https://example.test/qr",
            "qr_image_base64": "aW1hZ2U=",
            "qr_key": "qr-key",
            "ptqrtoken": "12345",
            "pt_login_sig": "login-sig",
        }
        with patch.object(
            main.qqmusic,
            "get_qr_key",
            new=AsyncMock(return_value=qr_payload),
        ):
            response = self.client.get(
                "/qqmusic/login/qr/key",
                headers={"Authorization": "Bearer test-api-token"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), qr_payload)

    def test_qr_check_route_forwards_all_session_fields(self):
        result = {
            "status": "success",
            "auth_url": "https://example.test/auth",
        }
        with (
            patch.object(
                main.qqmusic,
                "check_qr_status",
                new=AsyncMock(return_value=result),
            ) as check_mock,
            patch.object(main.qqmusic, "_pt_login_sig", "", create=True),
        ):
            response = self.client.get(
                "/qqmusic/login/qr/check",
                params={
                    "qr_key": "qr-key",
                    "ptqrtoken": "12345",
                    "pt_login_sig": "login-sig",
                },
                headers={"Authorization": "Bearer test-api-token"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), result)
        check_mock.assert_awaited_once_with("qr-key", "12345")

    def test_qr_confirm_persists_cookie_and_delete_clears_it(self):
        response = self.client.post(
            "/admin/qqmusic/qr/confirm",
            json={"auth_url": "https://example.test/auth"},
        )
        self.assertEqual(response.status_code, 403)

        with (
            patch.object(
                main.qqmusic,
                "confirm_qr_login",
                new=AsyncMock(return_value={"ok": True, "uin": "123"}),
            ),
            patch.object(
                main.qqmusic,
                "get_cookie",
                return_value="uin=123; qm_keyst=secret",
            ),
            patch.object(main.qqmusic, "get_uin", return_value="123"),
        ):
            response = self.client.post(
                "/admin/qqmusic/qr/confirm",
                json={"auth_url": "https://example.test/auth"},
                headers={"x-admin-token": "test-admin-token"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["admin_cookie_set"])

        status = self.client.get(
            "/admin/qqmusic/status",
            headers={"x-admin-token": "test-admin-token"},
        )
        self.assertEqual(status.status_code, 200)
        self.assertTrue(status.json()["admin_cookie_set"])

        cleared = self.client.delete(
            "/admin/qqmusic/cookie",
            headers={"x-admin-token": "test-admin-token"},
        )
        self.assertEqual(cleared.status_code, 200)
        self.assertFalse(cleared.json()["admin_cookie_set"])

        status = self.client.get(
            "/admin/qqmusic/status",
            headers={"x-admin-token": "test-admin-token"},
        )
        self.assertFalse(status.json()["admin_cookie_set"])

    def test_admin_compatibility_mode_allows_admin_routes_without_tokens(self):
        previous = main.settings.require_admin_auth
        main.settings.require_admin_auth = False
        try:
            cookie_status = self.client.get("/admin/qqmusic/status")
            settings_response = self.client.get("/admin/settings")
        finally:
            main.settings.require_admin_auth = previous

        self.assertEqual(cookie_status.status_code, 200)
        self.assertEqual(settings_response.status_code, 200)

    def test_shared_library_reads_saved_credentials_without_changing_player_client(self):
        payload = {"status": "ready", "account_id": "opaque", "account_version": "a" * 32, "items": []}
        with patch.object(main, "_shared_qq_cookie", return_value="fixture-cookie"), patch.object(main, "_check_qq_library_snapshot"), patch.object(main.qq_library, "directory", AsyncMock(return_value=payload)) as read, patch.object(main.qqmusic, "set_cookie") as mutate:
            result = self.client.get("/qqmusic/library?refresh=true", headers={"Authorization": "Bearer test-api-token"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), payload)
        self.assertEqual(result.headers["Cache-Control"], "private, no-store")
        read.assert_awaited_once_with("fixture-cookie", main.settings.cookie_key, True)
        mutate.assert_not_called()

    def test_shared_library_domain_errors_do_not_prompt_api_token(self):
        from backend.qq_library import LibraryError
        for status in ("expired", "unconfigured", "account_changed"):
            with patch.object(main, "_shared_qq_cookie", return_value="fixture"), patch.object(main.qq_library, "directory", AsyncMock(side_effect=LibraryError(status))):
                result = self.client.get("/qqmusic/library", headers={"Authorization": "Bearer test-api-token"})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["status"], status)

    def test_shared_detail_validates_identifier_version_and_late_account_change(self):
        from backend.qq_library import LibraryError
        headers = {"Authorization": "Bearer test-api-token"}
        self.assertEqual(self.client.get("/qqmusic/library/playlists/not-a-number?account_version=bad", headers=headers).status_code, 400)
        with patch.object(main, "_shared_qq_cookie", return_value="fixture"), patch.object(main.qq_library, "detail", AsyncMock(return_value={"status": "ready"})), patch.object(main, "_check_qq_library_snapshot", side_effect=LibraryError("account_changed")):
            result = self.client.get("/qqmusic/library/playlists/99?account_version=" + "a" * 32, headers=headers)
        self.assertEqual(result.json(), {"status": "account_changed"})

    def test_legacy_login_status_never_returns_raw_cookie(self):
        with patch.object(main.qqmusic, "get_cookie", return_value="MUST_NOT_RETURN"), patch.object(main.qqmusic, "refresh_login", AsyncMock(return_value={"success": True, "message": "valid"})):
            result = self.client.get("/qqmusic/login/status", headers={"Authorization": "Bearer test-api-token"})
        self.assertTrue(result.json()["logged_in"])
        self.assertNotIn("cookie", result.json())
        self.assertNotIn("MUST_NOT_RETURN", result.text)

    def test_websocket_requires_and_accepts_api_token_protocol(self):
        with self.assertRaises(WebSocketDisconnect) as rejected:
            with self.client.websocket_connect("/ws/status") as websocket:
                websocket.receive_text()
        self.assertEqual(rejected.exception.code, 1008)

        token_protocol = build_websocket_token_protocol("test-api-token")
        with self.client.websocket_connect(
            "/ws/status",
            subprotocols=["minerats-v1", token_protocol],
        ) as websocket:
            self.assertEqual(websocket.accepted_subprotocol, "minerats-v1")
            websocket.send_text("ping")
            self.assertEqual(websocket.receive_text(), '{"type":"pong"}')

@unittest.skipIf(main is None, f"backend runtime dependencies unavailable: {_IMPORT_ERROR}")
class BackendShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_awaits_workers_and_releases_socket_voice_resources(self):
        workers = [asyncio.create_task(asyncio.Event().wait()) for _ in range(3)]
        with (
            patch.object(main, "_chat_task", workers[0]),
            patch.object(main, "_ws_position_task", workers[1]),
            patch.object(main, "_ts_desc_task", workers[2]),
            patch.object(main.ws_manager, "close", AsyncMock()) as close_sockets,
            patch.object(main, "close_all_bilibili_qr_sessions", AsyncMock()) as close_qr,
            patch.object(main.voice, "close", AsyncMock()) as close_voice,
        ):
            await main._shutdown()
            self.assertTrue(all(task.done() for task in workers))
            self.assertIsNone(main._chat_task)
            self.assertIsNone(main._ws_position_task)
            self.assertIsNone(main._ts_desc_task)
        close_sockets.assert_awaited_once()
        close_qr.assert_awaited_once()
        close_voice.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
