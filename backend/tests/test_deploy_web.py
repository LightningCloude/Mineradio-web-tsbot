from __future__ import annotations

import argparse
from contextlib import redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "deploy_web.py"
SPEC = importlib.util.spec_from_file_location("deploy_web", SCRIPT_PATH)
assert SPEC and SPEC.loader
deploy_web = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy_web
SPEC.loader.exec_module(deploy_web)

DRILL_SCRIPT_PATH = REPO_ROOT / "scripts" / "drill_web_deployment.py"
DRILL_SPEC = importlib.util.spec_from_file_location(
    "drill_web_deployment",
    DRILL_SCRIPT_PATH,
)
assert DRILL_SPEC and DRILL_SPEC.loader
drill_web_deployment = importlib.util.module_from_spec(DRILL_SPEC)
sys.modules[DRILL_SPEC.name] = drill_web_deployment
DRILL_SPEC.loader.exec_module(drill_web_deployment)


def inspect_payload() -> str:
    return json.dumps(
        [
            {
                "Id": "web-container-id",
                "Config": {
                    "Image": "minerats-web:release-current",
                    "Labels": {
                        "com.docker.compose.project": "tsbot",
                        "com.docker.compose.service": "web",
                        "com.docker.compose.project.working_dir": "/srv/tsbot",
                        "com.docker.compose.project.config_files": (
                            "/srv/tsbot/docker-compose.prebuilt.yml,"
                            "/srv/releases/current/production-compose.override.yml"
                        ),
                    },
                },
                "NetworkSettings": {
                    "Networks": {
                        "tsbot_default": {},
                    }
                },
            }
        ]
    )


def remote_state():
    return deploy_web.parse_remote_state(
        inspect_payload(),
        container="tsbot-web-1",
        remote_group="ubuntu",
        service_ids={
            "web": "web-container-id",
            "backend": "backend-container-id",
            "voice-service": "voice-container-id",
        },
    )


class DeployWebTests(unittest.TestCase):
    def test_deploy_and_rollback_default_to_read_only(self):
        parser = deploy_web.build_parser()
        deploy_args = parser.parse_args(["deploy", "--host", "example.com"])
        rollback_args = parser.parse_args(
            [
                "rollback",
                "--host",
                "example.com",
                "--release",
                "20260730-web-r1",
            ]
        )
        self.assertFalse(deploy_args.execute)
        self.assertFalse(rollback_args.execute)
        self.assertFalse(deploy_args.skip_browser)
        self.assertFalse(rollback_args.skip_browser)
        explicit_dry_run = parser.parse_args(
            ["deploy", "--host", "example.com", "--dry-run"]
        )
        self.assertFalse(explicit_dry_run.execute)
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    ["deploy", "--host", "example.com", "--dry-run", "--execute"]
                )

    def test_rejects_shell_metacharacters_in_remote_identifiers(self):
        for validator, value in (
            (deploy_web.validate_host, "host;reboot"),
            (deploy_web.validate_user, "ubuntu root"),
            (deploy_web.validate_release, "../release"),
            (deploy_web.validate_container, "web$(id)"),
        ):
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    validator(value)

    def test_parses_compose_state_from_container_labels(self):
        state = remote_state()
        self.assertEqual(state.project, "tsbot")
        self.assertEqual(state.service, "web")
        self.assertEqual(state.base_compose, "/srv/tsbot/docker-compose.prebuilt.yml")
        self.assertEqual(
            state.current_override,
            "/srv/releases/current/production-compose.override.yml",
        )
        self.assertEqual(state.releases_root, "/srv/releases")
        self.assertEqual(state.network, "tsbot_default")

    def test_deploy_script_has_permission_probe_and_web_only_guards(self):
        state = remote_state()
        plan = deploy_web.make_plan(
            state,
            "20260730-210000-web-r1",
            "https://music.example.com",
        )
        script = deploy_web.build_deploy_script(
            state,
            plan,
            user="ubuntu",
            archive_sha256="a" * 64,
        )
        self.assertIn("sudo install -d -o ubuntu -g ubuntu", script)
        self.assertIn('sudo cp "$old_override" "$new_override"', script)
        self.assertIn("sudo chown ubuntu:ubuntu", script)
        self.assertIn("-p 127.0.0.1::8080", script)
        self.assertIn("up -d --no-deps web", script)
        self.assertIn("restoring the previous Web override", script)
        self.assertNotIn(" up -d backend", script)
        self.assertNotIn(" up -d voice-service", script)

    def test_rollback_script_restores_starting_override_on_error(self):
        state = remote_state()
        script = deploy_web.build_rollback_script(
            state,
            target_override="/srv/releases/older/production-compose.override.yml",
            target_image="minerats-web:release-older",
        )
        self.assertIn("target failed; restoring the starting override", script)
        self.assertEqual(script.count("up -d --no-deps web"), 2)
        self.assertIn("non-Web container changed", script)

    def test_release_archive_contains_only_the_runtime_allowlist(self):
        dist = REPO_ROOT / "web" / "dist"
        if not dist.exists():
            self.skipTest("web/dist is created by the build step")
        with tempfile.TemporaryDirectory() as temp_dir:
            archive_path = Path(temp_dir) / "release.tar.gz"
            digest = deploy_web.create_archive(archive_path)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
            with tarfile.open(archive_path, "r:gz") as archive:
                names = archive.getnames()
        self.assertIn("Dockerfile.web-dist", names)
        self.assertIn("LICENSE", names)
        self.assertIn("THIRD_PARTY_NOTICES.md", names)
        self.assertTrue(any(name.startswith("LICENSES/") for name in names))
        self.assertIn("docker/nginx-web.conf", names)
        self.assertIn("scripts/verify_deployment.py", names)
        self.assertTrue(any(name.startswith("web/dist/") for name in names))
        self.assertFalse(any(name.startswith("backend/") for name in names))

    def test_acceptance_token_is_never_built_into_remote_commands(self):
        state = remote_state()
        plan = deploy_web.make_plan(
            state,
            "20260730-210000-web-r1",
            "https://music.example.com",
        )
        script = deploy_web.build_deploy_script(
            state,
            plan,
            user="ubuntu",
            archive_sha256="b" * 64,
        )
        self.assertNotIn("TSBOT_API_TOKEN", script)
        self.assertNotIn("--api-token", script)

    def test_post_acceptance_failure_uses_the_starting_override(self):
        state = remote_state()
        calls = []
        original_acceptance = deploy_web.run_acceptance
        original_restore = deploy_web.restore_override

        def fail_acceptance(*args, **kwargs):
            raise deploy_web.DeploymentError("injected")

        def record_restore(runner, starting_state, override):
            calls.append((starting_state, override))

        deploy_web.run_acceptance = fail_acceptance
        deploy_web.restore_override = record_restore
        try:
            with self.assertRaisesRegex(
                deploy_web.DeploymentError,
                "restored for test",
            ):
                deploy_web.run_acceptance_or_restore(
                    object(),
                    state,
                    "https://music.example.com",
                    with_browser=True,
                    failure_message="restored for test",
                )
        finally:
            deploy_web.run_acceptance = original_acceptance
            deploy_web.restore_override = original_restore
        self.assertEqual(calls, [(state, state.current_override)])


class DeploymentDrillTests(unittest.TestCase):
    DRILL_ID = "20260730-210000-a1b2c3"

    def test_drill_defaults_to_plan_only(self):
        args = drill_web_deployment.build_parser().parse_args(
            ["--host", "example.com"]
        )
        self.assertFalse(args.execute)

    def test_drill_resources_are_isolated_and_publish_no_ports(self):
        names = drill_web_deployment.drill_names(self.DRILL_ID)
        setup = drill_web_deployment.setup_script(
            names,
            "ubuntu",
            "minerats-web:existing-base",
        )
        self.assertTrue(
            names["root"].startswith("/tmp/minerats-deploy-drill-")
        )
        self.assertIn("name: minerats-drill-", setup)
        self.assertNotIn("ports:", setup)
        self.assertNotIn("tsbot-v061-linux-amd64", setup)
        self.assertNotIn("/www/wwwroot", setup)

    def test_cleanup_is_scoped_to_the_exact_drill_prefix(self):
        names = drill_web_deployment.drill_names(self.DRILL_ID)
        cleanup = drill_web_deployment.cleanup_script(names)
        self.assertIn(names["root"], cleanup)
        self.assertIn(names["project"], cleanup)
        self.assertNotIn("docker system prune", cleanup)
        self.assertNotIn("docker volume prune", cleanup)

        unsafe = dict(names)
        unsafe["root"] = "/tmp"
        with self.assertRaises(drill_web_deployment.DrillError):
            drill_web_deployment.cleanup_script(unsafe)

    def test_drill_release_images_use_a_separate_repository(self):
        state = remote_state()
        names = drill_web_deployment.drill_names(self.DRILL_ID)
        plan = drill_web_deployment.make_drill_plan(
            state,
            names,
            self.DRILL_ID + "-success",
            "success",
        )
        self.assertTrue(plan.image.startswith("minerats-web-drill:"))
        self.assertNotEqual(plan.image, state.image)


if __name__ == "__main__":
    unittest.main()
