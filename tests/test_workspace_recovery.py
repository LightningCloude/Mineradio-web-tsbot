from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

from scripts import workspace_recovery as recovery


class WorkspaceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="minerats-recovery-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "project"
        self.workspace.mkdir()
        (self.workspace / "tsbot.env").write_text("PRIVATE_COOKIE_KEY=example-private-test-value\n", encoding="utf-8")
        (self.workspace / ".git").mkdir()
        (self.workspace / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        (self.workspace / "Cargo.lock").write_text("lockfile must survive", encoding="utf-8")
        (self.workspace / "node_modules").mkdir()
        (self.workspace / "node_modules" / "generated.js").write_text("ignored", encoding="utf-8")
        self.backups = self.root / "backups"

    def create(self, label="test"):
        return recovery.create_backup(self.workspace, self.backups, label=label, keep=0)

    def test_preserves_private_config_git_and_lockfile_without_dependencies(self):
        report = self.create()
        self.assertTrue(report["verified"])
        destination = self.root / "restored"
        recovery.restore_backup(Path(report["archive"]), destination)
        self.assertEqual((destination / "tsbot.env").read_bytes(), (self.workspace / "tsbot.env").read_bytes())
        self.assertTrue((destination / ".git" / "HEAD").is_file())
        self.assertTrue((destination / "Cargo.lock").is_file())
        self.assertFalse((destination / "node_modules").exists())

    def test_consistent_wal_snapshot_and_explicit_closed_connections(self):
        database = self.workspace / "tsbot.db"
        writer = sqlite3.connect(database)
        try:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("CREATE TABLE item(value TEXT)")
            writer.execute("INSERT INTO item VALUES ('committed-before-backup')")
            writer.commit()
            writer.execute("INSERT INTO item VALUES ('uncommitted-not-a-snapshot')")
            report = self.create()
            self.assertEqual(report["sqlite_snapshots"], 1)
            destination = self.root / "restored"
            recovery.restore_backup(Path(report["archive"]), destination)
            restored = sqlite3.connect(destination / "tsbot.db")
            try:
                self.assertEqual(restored.execute("SELECT value FROM item").fetchall(), [("committed-before-backup",)])
            finally:
                restored.close()
            self.assertFalse((destination / "tsbot.db-wal").exists())
            self.assertFalse((destination / "tsbot.db-shm").exists())
            # This fails on Windows if snapshot or restore connections leak.
            (destination / "tsbot.db").unlink()
        finally:
            writer.rollback()
            writer.close()

    def test_archive_corruption_is_rejected_before_restore(self):
        archive = Path(self.create()["archive"])
        with archive.open("ab") as handle:
            handle.write(b"corruption")
        with self.assertRaisesRegex(recovery.RecoveryError, "SHA256 mismatch"):
            recovery.restore_backup(archive, self.root / "never-created")
        self.assertFalse((self.root / "never-created").exists())

    def test_existing_restore_target_is_never_overwritten(self):
        archive = Path(self.create()["archive"])
        marker = self.workspace / "user-marker"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "must not exist"):
            recovery.restore_backup(archive, self.workspace)
        self.assertEqual(marker.read_text(), "keep")

    def test_retention_deletes_only_verified_managed_archives(self):
        reports = [self.create(label=str(index)) for index in range(4)]
        unrelated = self.backups / "old-user-backup.zip"
        unrelated.write_bytes(b"do not erase")
        corrupt = self.backups / "minerats-full-corrupt.zip"
        corrupt.write_bytes(b"do not erase")
        removed = recovery.prune_backups(self.backups, 3)
        self.assertEqual(removed, [reports[0]["archive"]])
        self.assertTrue(unrelated.exists())
        self.assertTrue(corrupt.exists())
        self.assertFalse(Path(reports[0]["archive"]).with_suffix(".zip.sha256").exists())

    def test_zip_path_traversal_is_rejected_even_with_updated_sidecar(self):
        archive = Path(self.create()["archive"])
        with zipfile.ZipFile(archive, "a") as bundle:
            bundle.writestr("../escape", "malicious")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_suffix(".zip.sha256").write_text(digest, encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "Unsafe archive path"):
            recovery.verify_backup(archive)

    def test_backups_inside_source_are_rejected(self):
        with self.assertRaisesRegex(recovery.RecoveryError, "outside the workspace"):
            recovery.create_backup(self.workspace, self.workspace / "backups")

    def test_manifest_detects_valid_zip_content_tampering(self):
        archive = Path(self.create()["archive"])
        replacement = self.root / "replacement.zip"
        with zipfile.ZipFile(archive) as source, zipfile.ZipFile(replacement, "w") as output:
            for name in source.namelist():
                data = source.read(name)
                if name == recovery.MANIFEST_PATH:
                    manifest = json.loads(data)
                    manifest["files"][0]["sha256"] = "0" * 64
                    data = json.dumps(manifest).encode()
                output.writestr(name, data)
        replacement.replace(archive)
        archive.with_suffix(".zip.sha256").write_text(recovery.sha256_file(archive), encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "File SHA256 mismatch"):
            recovery.verify_backup(archive)


if __name__ == "__main__":
    unittest.main()
