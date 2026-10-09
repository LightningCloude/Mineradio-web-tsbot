import unittest
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.db import get_session
from backend.public_routes import create_readiness_router, router


class PublicReadinessTests(unittest.TestCase):
    def make_client(self, *, database_ok=True, voice_ok=True):
        class Session:
            def execute(self, query):
                if not database_ok:
                    raise RuntimeError('private database details')

        class Voice:
            ping = AsyncMock(return_value='version', side_effect=None if voice_ok else RuntimeError('private host'))

        app = FastAPI()
        app.include_router(router)
        app.include_router(create_readiness_router(Voice()))
        app.dependency_overrides[get_session] = lambda: Session()
        return TestClient(app)

    def test_liveness_and_readiness_without_secrets(self):
        with self.make_client() as client:
            self.assertEqual(client.get('/health/live').json(), {'ok': True})
            response = client.get('/health/ready')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {'ok': True, 'checks': {'database': True, 'voice': True}})

    def test_failed_dependencies_are_503_without_internal_error_details(self):
        for database, voice in [(False, True), (True, False), (False, False)]:
            with self.make_client(database_ok=database, voice_ok=voice) as client:
                response = client.get('/health/ready')
                self.assertEqual(response.status_code, 503)
                self.assertNotIn('private', response.text)
                self.assertEqual(response.json()['checks'], {'database': database, 'voice': voice})

    def test_asset_and_public_config_contracts_survive_router_extraction(self):
        with self.make_client() as client:
            self.assertEqual(set(client.get('/config/public').json()), {'app_name', 'app_icon', 'log_level'})
            self.assertEqual(client.get('/assets/unknown').status_code, 404)
