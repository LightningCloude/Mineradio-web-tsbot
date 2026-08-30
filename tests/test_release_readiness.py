from pathlib import Path
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet

from backend import crypto
from backend.config import settings
from backend.main import _path_requires_api_token


ROOT = Path(__file__).resolve().parents[1]


class SecurityDefaultsTests(unittest.TestCase):
    def test_security_validation_fails_closed_for_example_credentials(self) -> None:
        with (
            patch.object(settings, "cookie_key", "dev-cookie-key"),
            patch.object(settings, "require_api_auth", True),
            patch.object(settings, "api_token", ""),
            patch.object(settings, "api_tokens", ""),
        ):
            with self.assertRaises(RuntimeError):
                settings.validate_security()

    def test_security_validation_accepts_explicit_unique_secrets(self) -> None:
        with (
            patch.object(settings, "cookie_key", "cookie-key-with-at-least-thirty-two-characters"),
            patch.object(settings, "require_api_auth", True),
            patch.object(settings, "api_token", "api-token"),
            patch.object(settings, "api_tokens", ""),
        ):
            settings.validate_security()

    def test_plain_44_character_cookie_secret_uses_legacy_derivation(self) -> None:
        secret = "validation-cookie-key-at-least-32-characters"
        self.assertEqual(44, len(secret))
        with patch.object(settings, "cookie_key", secret):
            encrypted = crypto.encrypt_text("release-check")
            self.assertEqual("release-check", crypto.decrypt_text(encrypted))

    def test_valid_fernet_cookie_key_remains_compatible(self) -> None:
        key = Fernet.generate_key().decode("ascii")
        with patch.object(settings, "cookie_key", key):
            encrypted = crypto.encrypt_text("legacy-cookie")
            self.assertEqual("legacy-cookie", crypto.decrypt_text(encrypted))

    def test_api_auth_covers_control_routes(self) -> None:
        with patch.object(settings, "require_api_auth", True):
            for path in (
                "/external/status",
                "/voice/volume",
                "/qqmusic/login/qr/key",
                "/lyrics/1",
            ):
                self.assertTrue(_path_requires_api_token(path), path)

            for path in (
                "/docs",
                "/openapi.json",
                "/config/public",
                "/auth/login",
                "/admin/settings",
                "/assets/web-app-icon",
                "/cover/example.jpg",
            ):
                self.assertFalse(_path_requires_api_token(path), path)

    def test_compose_binds_internal_ports_to_loopback(self) -> None:
        for name in (
            "docker-compose.yml",
            "docker-compose.prebuilt.yml",
            "docker-compose.portable.yml",
        ):
            text = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn('"127.0.0.1:8009:8009"', text, name)
            self.assertIn('"127.0.0.1:50051:50051"', text, name)
            self.assertNotIn('"8009:8009"', text.replace('"127.0.0.1:8009:8009"', ''), name)
            self.assertNotIn('"50051:50051"', text.replace('"127.0.0.1:50051:50051"', ''), name)

    def test_prebuilt_defaults_point_to_this_project_images(self) -> None:
        text = (ROOT / "docker-compose.prebuilt.yml").read_text(encoding="utf-8")
        self.assertIn("TSBOT_IMAGE_REGISTRY:-ghcr.io", text)
        self.assertIn("TSBOT_IMAGE_NAMESPACE:-lightningcloude", text)
        self.assertIn("TSBOT_IMAGE_REPO:-mineradio-web-tsbot", text)


class ReleaseLicenseTests(unittest.TestCase):
    def test_root_and_component_licenses_are_present(self) -> None:
        root_license = (ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertTrue(root_license.startswith("GNU GENERAL PUBLIC LICENSE"))
        for relative in (
            "THIRD_PARTY_NOTICES.md",
            "LICENSES/Mineradio-GPL-3.0.txt",
            "LICENSES/Mineradio-NOTICE.md",
            "LICENSES/Sonic-Topography-Non-Commercial.txt",
            "LICENSES/NeteaseTSBot-original-MIT.txt",
            "LICENSES/ReSpeak-MIT.txt",
            "LICENSES/ReSpeak-Apache-2.0.txt",
            "LICENSES/Three.js-MIT.txt",
            "LICENSES/GSAP-3.15.0-NOTICE.txt",
        ):
            self.assertTrue((ROOT / relative).is_file(), relative)

    def test_release_workflow_and_images_include_license_material(self) -> None:
        workflow = (ROOT / ".github/workflows/docker-publish.yml").read_text(encoding="utf-8")
        self.assertIn("python -m unittest discover -s backend/tests -v", workflow)
        self.assertIn("python -m unittest discover -s tests -v", workflow)
        self.assertIn("npm --prefix web test", workflow)
        self.assertIn("npm --prefix web audit", workflow)
        self.assertIn("cargo test --manifest-path voice-service/Cargo.toml --locked", workflow)
        self.assertGreaterEqual(workflow.count("toolchain: 1.88.0"), 2)
        self.assertIn("Check Docker Hub credentials", workflow)
        self.assertIn("secrets.DOCKERHUB_USERNAME", workflow)
        self.assertIn("secrets.DOCKERHUB_TOKEN", workflow)
        self.assertIn("docker.io/${{ steps.prep.outputs.dockerhub_namespace }}", workflow)
        self.assertIn("ghcr.io/${{ steps.prep.outputs.ghcr_owner }}/${{ steps.prep.outputs.repo }}", workflow)
        self.assertIn("cp -R LICENSES", workflow)

        for name in (
            "Dockerfile.backend",
            "Dockerfile.voice-service",
            "Dockerfile.web",
            "Dockerfile.web-dist",
        ):
            text = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn("THIRD_PARTY_NOTICES.md", text, name)
            self.assertIn("COPY LICENSES", text, name)

    def test_voice_service_uses_a_committed_lockfile_contract(self) -> None:
        self.assertTrue((ROOT / "voice-service/Cargo.lock").is_file())
        dockerfile = (ROOT / "Dockerfile.voice-service").read_text(encoding="utf-8")
        self.assertIn("cargo build", dockerfile)
        self.assertIn("--locked", dockerfile)


if __name__ == "__main__":
    unittest.main()
