from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch


_IMPORT_ERROR: ModuleNotFoundError | None = None
_TEST_DB_PATH = Path(tempfile.gettempdir()) / f"minerats-api-routes-{os.getpid()}.db"
_ORIGINAL_CWD = Path.cwd()

try:
    os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB_PATH.as_posix()}"
    os.environ["TSBOT_API_TOKEN"] = "test-api-token"
    os.environ["TSBOT_ADMIN_TOKEN"] = "test-admin-token"
    os.environ["TSBOT_COOKIE_KEY"] = "test-cookie-key"
    os.chdir(tempfile.gettempdir())

    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from backend.auth_contracts import build_websocket_token_protocol
    from backend import db, main
except ModuleNotFoundError as exc:
    _IMPORT_ERROR = exc
    TestClient = None
    db = None
    main = None
finally:
    os.chdir(_ORIGINAL_CWD)


@unittest.skipIf(main is None, f"backend runtime dependencies unavailable: {_IMPORT_ERROR}")
class ApiRouteIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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

    def test_shared_beat_cache_is_name_normalized_and_first_writer_wins(self):
        headers = {"Authorization": "Bearer test-api-token"}
        miss = self.client.get(
            "/visual/beat-cache",
            params={"name": "  Shared   Song  "},
            headers=headers,
        )
        self.assertEqual(miss.status_code, 200)
        self.assertFalse(miss.json()["hit"])

        first_result = {
            "gridStep": 0.5,
            "duration": 1.5,
            "beats": [
                {"time": 0.0, "type": "downbeat", "strength": 0.8, "sectionEnergy": 0.2},
                {"time": 0.5, "type": "push", "strength": 0.6, "sectionEnergy": 0.4},
            ],
        }
        created = self.client.post(
            "/visual/beat-cache",
            json={"name": "Shared Song", "result": first_result},
            headers=headers,
        )
        self.assertEqual(created.status_code, 200)
        self.assertTrue(created.json()["created"])

        duplicate = self.client.post(
            "/visual/beat-cache",
            json={
                "name": "ＳＨＡＲＥＤ song",
                "result": {**first_result, "gridStep": 0.72},
            },
            headers=headers,
        )
        self.assertEqual(duplicate.status_code, 200)
        self.assertFalse(duplicate.json()["created"])
        self.assertEqual(duplicate.json()["result"]["gridStep"], 0.5)

        hit = self.client.get(
            "/visual/beat-cache",
            params={"name": "shared song"},
            headers=headers,
        )
        self.assertTrue(hit.json()["hit"])
        self.assertEqual(hit.json()["result"]["beatCount"], 2)
        self.assertEqual(hit.json()["result"]["beats"][0]["offline"], True)

if __name__ == "__main__":
    unittest.main()
