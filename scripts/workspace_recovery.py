#!/usr/bin/env python3
"""Private, verified workspace restore points (not a public release archive).

Includes Git metadata, untracked configuration, identity files and consistent
SQLite snapshots. Dependencies and generated build/cache output are excluded.
Restoration is deliberately restricted to a new directory, never over a running
installation. Archives contain secrets and must not be published or committed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
import zipfile


SCHEMA = "minerats-workspace-recovery-v1"
MANIFEST_PATH = ".minerats-recovery/manifest.json"
PREFIX = "minerats-full-"
EXCLUDED_DIRS = {
    ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
    ".vite", "target", "dist", "artifacts", ".release-tooling",
}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}


class RecoveryError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_sqlite(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def _sqlite_snapshot(source: Path, destination: Path) -> None:
    # sqlite3 connection context managers commit/rollback but do not close.
    # Explicit closing is essential before ZIP reads / TemporaryDirectory
    # cleanup on Windows, and before live DB replacement during deployment.
    reader = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
    writer = sqlite3.connect(destination)
    try:
        deadline = time.monotonic() + 60
        def progress(_status, _remaining, _total):
            if time.monotonic() > deadline:
                raise RecoveryError(f"SQLite snapshot deadline exceeded: {source.name}")
        reader.backup(writer, pages=512, sleep=0.01, progress=progress)
        result = writer.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise RecoveryError(f"SQLite integrity check failed: {source.name}")
        writer.commit()
    finally:
        writer.close()
        reader.close()


def workspace_files(workspace: Path):
    for directory, children, files in os.walk(workspace, followlinks=False):
        current = Path(directory)
        children[:] = sorted(name for name in children if name not in EXCLUDED_DIRS)
        for name in children:
            if (current / name).is_symlink():
                raise RecoveryError(f"Symlink directories need a separate backup: {current / name}")
        for name in sorted(files):
            path = current / name
            if path.suffix in EXCLUDED_SUFFIXES or (".git" in path.relative_to(workspace).parts and name.endswith(".lock")):
                continue
            if path.is_symlink():
                raise RecoveryError(f"Symlink files need a separate backup: {path}")
            if name.endswith(("-wal", "-shm", "-journal")):
                database = path.with_name(name.rsplit("-", 1)[0])
                if database.is_file() and _is_sqlite(database):
                    continue  # Included transactionally in its database snapshot.
            relative = path.relative_to(workspace).as_posix()
            if relative == MANIFEST_PATH:
                raise RecoveryError(f"Reserved recovery manifest already exists: {relative}")
            yield path, relative


def _git_metadata(workspace: Path) -> dict:
    metadata = {}
    for key, arguments in {
        "commit": ["rev-parse", "HEAD"],
        "branch": ["branch", "--show-current"],
        "worktree_status": ["status", "--porcelain=v1"],
    }.items():
        try:
            result = subprocess.run(
                ["git", "-C", str(workspace), *arguments],
                capture_output=True, text=True, timeout=15, check=False,
            )
        except FileNotFoundError:
            return {"commit": None, "branch": None, "worktree_status": None,
                    "note": "Git executable unavailable; any on-disk .git files are still included"}
        metadata[key] = result.stdout.strip() if result.returncode == 0 else None
    return metadata


def _runtime_images(images: list[str]) -> dict:
    result = {}
    for image in images:
        query = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{.Id}}", image],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if query.returncode:
            raise RecoveryError(f"Cannot resolve runtime image: {image}")
        result[image] = query.stdout.strip()
    return result


def create_backup(workspace: Path, output_directory: Path, *, label: str = "restore",
                  keep: int = 3, images: list[str] | None = None) -> dict:
    workspace = workspace.resolve(strict=True)
    output_directory = output_directory.resolve()
    if not workspace.is_dir() or workspace.parent == workspace:
        raise RecoveryError("Workspace must be a specific project directory")
    if output_directory == workspace or output_directory.is_relative_to(workspace):
        raise RecoveryError("Backups must be stored outside the workspace")
    if output_directory.parent == output_directory:
        raise RecoveryError("Backup directory must not be a filesystem root")
    if (workspace / ".git").is_file():
        raise RecoveryError("Linked worktrees require a separate Git metadata backup")
    if keep < 0:
        raise RecoveryError("Retention must be zero (disabled) or positive")
    safe_label = "".join(character if character.isalnum() or character in "-_" else "-"
                         for character in label).strip("-")[:80] or "restore"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive = output_directory / f"{PREFIX}{stamp}-{safe_label}.zip"
    partial = archive.with_suffix(".zip.partial")
    manifest = {
        "schema": SCHEMA, "created_utc": datetime.now(timezone.utc).isoformat(),
        "workspace": str(workspace), "git": _git_metadata(workspace),
        "runtime_images": _runtime_images(images or []),
        "excluded_directories": sorted(EXCLUDED_DIRS), "files": [],
        "private": True,
    }
    try:
        with tempfile.TemporaryDirectory(prefix="minerats-sqlite-") as temporary:
            # Protect secrets from the first byte written on POSIX. Windows
            # callers should select a backup directory with private NTFS ACLs.
            descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as archive_stream, zipfile.ZipFile(archive_stream, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                for index, (path, relative) in enumerate(workspace_files(workspace)):
                    sqlite_snapshot = _is_sqlite(path)
                    archived = path
                    if sqlite_snapshot:
                        archived = Path(temporary) / f"database-{index}.sqlite"
                        _sqlite_snapshot(path, archived)
                    # Hash exactly the bytes archived, even for concurrently
                    # appended logs. Stream large Git packs instead of retaining
                    # hundreds of megabytes in memory.
                    information = zipfile.ZipInfo.from_file(path, relative)
                    information.compress_type = zipfile.ZIP_DEFLATED
                    file_digest = hashlib.sha256()
                    byte_count = 0
                    with archived.open("rb") as source, bundle.open(information, "w", force_zip64=True) as output:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            output.write(chunk)
                            file_digest.update(chunk)
                            byte_count += len(chunk)
                    manifest["files"].append({
                        "path": relative, "size": byte_count,
                        "sha256": file_digest.hexdigest(),
                        "sqlite_snapshot": sqlite_snapshot,
                    })
                bundle.writestr(MANIFEST_PATH, json.dumps(manifest, ensure_ascii=False, indent=2))
        partial.replace(archive)
        digest = sha256_file(archive)
        archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
        report = verify_backup(archive)
        removed = prune_backups(output_directory, keep) if keep else []
        return {**report, "removed": removed}
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def _safe_member(name: str) -> PurePosixPath:
    member = PurePosixPath(name)
    if (not name or "\\" in name or member.is_absolute() or ".." in member.parts
            or any(":" in part for part in member.parts)):
        raise RecoveryError(f"Unsafe archive path: {name}")
    return member


def verify_backup(archive: Path) -> dict:
    archive = archive.resolve(strict=True)
    sidecar = archive.with_suffix(".zip.sha256")
    if not sidecar.is_file():
        raise RecoveryError("Missing archive SHA256 sidecar")
    expected = sidecar.read_text(encoding="utf-8").split()[0].lower()
    digest = sha256_file(archive)
    if expected != digest:
        raise RecoveryError("Archive SHA256 mismatch")
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        if len(names) != len(set(names)):
            raise RecoveryError("Archive contains duplicate paths")
        for information in bundle.infolist():
            _safe_member(information.filename)
            mode = information.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise RecoveryError("Archive contains a symlink")
        try:
            manifest = json.loads(bundle.read(MANIFEST_PATH))
        except (KeyError, ValueError) as exc:
            raise RecoveryError("Missing or invalid recovery manifest") from exc
        if manifest.get("schema") != SCHEMA:
            raise RecoveryError("Unsupported recovery schema")
        entries = manifest.get("files")
        if not isinstance(entries, list):
            raise RecoveryError("Invalid manifest file list")
        expected_names = {MANIFEST_PATH}
        total_bytes = 0
        for entry in entries:
            name = entry["path"]
            _safe_member(name)
            if name in expected_names:
                raise RecoveryError("Duplicate manifest file")
            expected_names.add(name)
            information = bundle.getinfo(name)
            if information.file_size != entry["size"]:
                raise RecoveryError(f"Size mismatch: {name}")
            file_digest = hashlib.sha256()
            with bundle.open(name) as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    file_digest.update(chunk)
            if file_digest.hexdigest() != entry["sha256"]:
                raise RecoveryError(f"File SHA256 mismatch: {name}")
            total_bytes += entry["size"]
        if set(names) != expected_names:
            raise RecoveryError("Archive contains unmanifested files")
    return {
        "archive": str(archive), "sha256": digest, "files": len(entries),
        "uncompressed_bytes": total_bytes, "created_utc": manifest["created_utc"],
        "sqlite_snapshots": sum(bool(entry.get("sqlite_snapshot")) for entry in entries),
        "git": manifest.get("git"), "runtime_images": manifest.get("runtime_images", {}),
        "verified": True,
    }


def restore_backup(archive: Path, destination: Path) -> dict:
    report = verify_backup(archive)
    destination = destination.resolve()
    if destination.exists():
        raise RecoveryError("Restore destination must not exist; never overwrite a live workspace")
    if destination.parent == destination:
        raise RecoveryError("Cannot restore into a filesystem root")
    destination.mkdir(parents=True, exist_ok=False)
    try:
        with zipfile.ZipFile(archive) as bundle:
            manifest = json.loads(bundle.read(MANIFEST_PATH))
            for entry in manifest["files"]:
                member = _safe_member(entry["path"])
                target = destination.joinpath(*member.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry["path"]) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                mode = bundle.getinfo(entry["path"]).external_attr >> 16
                if mode and os.name != "nt":
                    target.chmod(stat.S_IMODE(mode))
                if sha256_file(target) != entry["sha256"]:
                    raise RecoveryError(f"Restored file checksum mismatch: {entry['path']}")
                if entry.get("sqlite_snapshot"):
                    connection = sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)
                    try:
                        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                            raise RecoveryError(f"Restored database invalid: {entry['path']}")
                    finally:
                        connection.close()
        return {**report, "restored_to": str(destination)}
    except Exception:
        # Preserve partial evidence, never recursively delete a computed target.
        raise


def prune_backups(directory: Path, keep: int) -> list[str]:
    if keep <= 0:
        return []
    directory = directory.resolve(strict=True)
    if directory.parent == directory:
        raise RecoveryError("Cannot prune a filesystem root")
    verified = []
    for archive in directory.glob(f"{PREFIX}*.zip"):
        if archive.is_symlink() or archive.resolve().parent != directory:
            continue
        try:
            report = verify_backup(archive)
        except (RecoveryError, OSError, zipfile.BadZipFile, KeyError):
            continue  # Never erase unfamiliar, incomplete or corrupt backups.
        verified.append((report["created_utc"], archive))
    verified.sort(key=lambda item: item[0], reverse=True)
    removed = []
    for _, archive in verified[keep:]:
        archive.unlink()
        archive.with_suffix(".zip.sha256").unlink()
        removed.append(str(archive))
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup")
    backup.add_argument("--workspace", type=Path, required=True)
    backup.add_argument("--output-dir", type=Path, required=True)
    backup.add_argument("--label", default="restore")
    backup.add_argument("--keep", type=int, default=3, help="Keep newest verified full backups; 0 disables pruning")
    backup.add_argument("--image", action="append", default=[], help="Record an installed Docker image's immutable ID")
    verify = commands.add_parser("verify")
    verify.add_argument("archive", type=Path)
    restore = commands.add_parser("restore")
    restore.add_argument("archive", type=Path)
    restore.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "backup":
            result = create_backup(arguments.workspace, arguments.output_dir,
                                   label=arguments.label, keep=arguments.keep, images=arguments.image)
        elif arguments.command == "verify":
            result = verify_backup(arguments.archive)
        else:
            result = restore_backup(arguments.archive, arguments.destination)
    except (RecoveryError, OSError, sqlite3.Error, zipfile.BadZipFile, KeyError) as exc:
        parser.exit(1, f"Recovery failed: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
