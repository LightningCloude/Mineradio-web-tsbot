import tarfile
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from scripts import deploy_queue_clear as release


class PairedDeploymentTests(unittest.TestCase):
    def test_package_contains_source_and_built_assets_but_no_runtime_or_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'release.tar.gz'
            # Backend tests run before npm build in a clean CI checkout. Supply
            # our own fixture tree instead of depending on the real web/dist.
            root = Path(folder) / 'project'
            for name in ('Dockerfile.backend-update', 'Dockerfile.web-dist', 'backend/main.py',
                         'backend/tests/test_clear_queue.py', 'proto/voice.proto', 'web/dist/index.html',
                         'docker/nginx-web.conf', 'LICENSE', 'LICENSES/fixture.txt', 'THIRD_PARTY_NOTICES.md',
                         'backend/.env', 'backend/.venv/private.py', 'backend/__pycache__/private.pyc', 'backend/private.db'):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('isolated fixture', encoding='utf-8')
            with patch.object(release.deploy, 'REPO_ROOT', root):
                digest = release.create_package(archive)
            self.assertEqual(len(digest), 64)
            with tarfile.open(archive) as package:
                names = package.getnames()
                self.assertEqual(package.getmember('web/dist/index.html').mode, 0o644)
                self.assertEqual(package.getmember('web/dist').mode, 0o755)
        self.assertIn('backend/main.py', names)
        self.assertIn('backend/tests/test_clear_queue.py', names)
        self.assertIn('web/dist/index.html', names)
        self.assertFalse(any('.venv' in name or '__pycache__' in name or name.endswith(('.env', '.db', '.sqlite')) for name in names))

    def test_switch_targets_only_backend_and_web_with_checkpoint_and_rollback(self):
        state = release.deploy.RemoteState(container='tsbot-web-1', image='old-web', container_id='web-id', project='tsbot', service='web',
            working_dir='/srv/tsbot', config_files=('/srv/tsbot/docker-compose.yml', '/srv/releases/old/production-compose.override.yml'),
            network='tsbot_default', remote_group='ubuntu', service_ids={'voice-service': 'voice-id', 'backend': 'backend-id', 'web': 'web-id'})
        script = release.remote_script(state, 'safe-r1', '/tmp/safe.tar.gz', 'a' * 64, 'new-backend', 'sha256:' + 'b' * 64)
        self.assertIn('up -d --no-deps backend', script)
        self.assertIn('up -d --no-deps web', script)
        self.assertIn('trap cleanup EXIT', script)
        self.assertIn('source.backup(target)', script)
        self.assertIn('TSBOT_RELEASE_PLAYBACK_CHECKPOINT', script)
        self.assertIn('Current track metadata was not restored', script)
        self.assertNotIn('up -d --no-deps voice-service', script)
        self.assertNotIn('/external/queue', script)
        self.assertNotIn('/external/player/action', script)
        self.assertNotIn('docker compose down', script)


if __name__ == '__main__': unittest.main()
