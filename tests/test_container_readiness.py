from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from scripts.ci_browser_smoke import create_app


ROOT = Path(__file__).resolve().parents[1]


class ContainerReadinessContractTests(unittest.TestCase):
    def test_all_compose_services_have_bounded_logs_restart_and_checks(self):
        for name in ("docker-compose.yml", "docker-compose.prebuilt.yml", "docker-compose.portable.yml"):
            with self.subTest(compose=name):
                source = (ROOT / name).read_text(encoding="utf-8")
                self.assertEqual(source.count("restart: unless-stopped"), 3)
                self.assertEqual(source.count("healthcheck:"), 3)
                self.assertEqual(source.count('max-size: "10m"'), 3)
                self.assertEqual(source.count('max-file: "3"'), 3)
                self.assertEqual(source.count("condition: service_healthy"), 2)
                self.assertIn('"127.0.0.1:50051:50051"', source)
                self.assertIn('"127.0.0.1:8009:8009"', source)
                if name != "docker-compose.portable.yml":
                    self.assertIn('"--healthcheck", "127.0.0.1:50051"', source)
                    self.assertIn("/health/ready", source)
                else:
                    # Frozen portable image predates the dedicated health API.
                    self.assertIn("/dev/tcp/127.0.0.1/50051", source)
                    self.assertIn("/openapi.json", source)

    def test_all_current_docker_images_have_standalone_healthcheck(self):
        for name in ("Dockerfile.backend", "Dockerfile.backend-update", "Dockerfile.voice-service", "Dockerfile.voice-service-update", "Dockerfile.web", "Dockerfile.web-dist"):
            with self.subTest(dockerfile=name):
                self.assertIn("HEALTHCHECK --interval=20s", (ROOT / name).read_text(encoding="utf-8"))

    def test_ci_fixtures_serve_reads_and_reject_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary)
            (dist / "index.html").write_text("<html>fixture</html>", encoding="utf-8")
            with TestClient(create_app(dist)) as client:
                self.assertEqual(client.get("/").status_code, 200)
                self.assertEqual(len(client.get("/api/external/queue").json()["items"]), 7)
                self.assertEqual(client.get("/api/external/status").json()["state"], "playing")
                self.assertFalse(client.get("/api/admin/qqmusic/status").json()["cookie_set"])
                for method in ("post", "put", "delete"):
                    self.assertEqual(getattr(client, method)("/api/external/queue").status_code, 404)


if __name__ == "__main__":
    unittest.main()
