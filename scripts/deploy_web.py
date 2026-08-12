#!/usr/bin/env python3
"""Safely deploy or roll back only the TSBot Web service.

The default mode is a read-only dry run. Remote writes and Compose changes are
only enabled by the explicit --execute flag.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTAINER = "tsbot-v061-linux-amd64-web-1"
HOST_RE = re.compile(
    r"^(?:"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"|[0-9A-Fa-f:]+"
    r")$"
)
USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,31}$")
RELEASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$")
CONTAINER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$")
SAFE_ARCHIVE_ROOTS = (
    "Dockerfile.web-dist",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "LICENSES",
    "docker/nginx-web.conf",
    "web/dist",
    "scripts/verify_deployment.py",
)
MIN_REMOTE_FREE_KIB = 2 * 1024 * 1024


class DeploymentError(RuntimeError):
    """A release safety check or command failed."""


@dataclass(frozen=True)
class RemoteState:
    container: str
    image: str
    container_id: str
    project: str
    service: str
    working_dir: str
    config_files: tuple[str, ...]
    network: str
    remote_group: str
    service_ids: dict[str, str]

    @property
    def base_compose(self) -> str:
        return self.config_files[0]

    @property
    def current_override(self) -> str:
        return self.config_files[-1]

    @property
    def releases_root(self) -> str:
        return str(PurePosixPath(self.current_override).parent.parent)


@dataclass(frozen=True)
class ReleasePlan:
    release: str
    image: str
    release_dir: str
    override: str
    remote_archive: str
    public_url: str


def validate_host(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 253 or not HOST_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"invalid SSH host: {value!r}")
    return value


def validate_user(value: str) -> str:
    if not USER_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"invalid SSH user: {value!r}")
    return value


def validate_release(value: str) -> str:
    if not RELEASE_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "release may only contain letters, digits, dot, underscore and dash"
        )
    return value


def validate_container(value: str) -> str:
    if not CONTAINER_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"invalid container name: {value!r}")
    return value


def normalize_public_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise argparse.ArgumentTypeError("public URL must be an absolute HTTP(S) URL")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise argparse.ArgumentTypeError(
            "public URL must not contain credentials, query or fragment"
        )
    return value.strip().rstrip("/")


def require_absolute_posix_path(value: str, label: str) -> str:
    path = PurePosixPath(value)
    if not value.startswith("/") or ".." in path.parts:
        raise DeploymentError(f"{label} is not a safe absolute path: {value!r}")
    return str(path)


def split_config_files(value: Any) -> tuple[str, ...]:
    if isinstance(value, list):
        raw = value
    elif isinstance(value, str):
        raw = value.split(",")
    else:
        raw = []
    files = tuple(
        require_absolute_posix_path(str(item).strip(), "Compose config file")
        for item in raw
        if str(item).strip()
    )
    if len(files) < 2:
        raise DeploymentError(
            "the Web container does not expose both base and override Compose files"
        )
    return files


def parse_remote_state(
    inspect_payload: str,
    *,
    container: str,
    remote_group: str,
    service_ids: Mapping[str, str] | None = None,
) -> RemoteState:
    try:
        parsed = json.loads(inspect_payload)
        item = parsed[0] if isinstance(parsed, list) else parsed
    except (json.JSONDecodeError, IndexError, TypeError) as exc:
        raise DeploymentError(f"invalid docker inspect response: {exc}") from exc

    labels = item.get("Config", {}).get("Labels") or {}
    image = str(item.get("Config", {}).get("Image") or "")
    container_id = str(item.get("Id") or "")
    project = str(labels.get("com.docker.compose.project") or "")
    service = str(labels.get("com.docker.compose.service") or "")
    working_dir = require_absolute_posix_path(
        str(labels.get("com.docker.compose.project.working_dir") or ""),
        "Compose working directory",
    )
    config_files = split_config_files(
        labels.get("com.docker.compose.project.config_files")
    )
    networks = item.get("NetworkSettings", {}).get("Networks") or {}
    preferred_network = f"{project}_default"
    network = preferred_network if preferred_network in networks else next(
        iter(networks), ""
    )

    if not IMAGE_RE.fullmatch(image):
        raise DeploymentError(f"unsafe or missing Web image name: {image!r}")
    if not project or not service or service != "web":
        raise DeploymentError(
            f"container {container!r} is not a Compose Web service"
        )
    if not container_id or not network:
        raise DeploymentError("container ID or Docker network is missing")
    if not USER_RE.fullmatch(remote_group):
        raise DeploymentError(f"unsafe remote group: {remote_group!r}")

    return RemoteState(
        container=container,
        image=image,
        container_id=container_id,
        project=project,
        service=service,
        working_dir=working_dir,
        config_files=config_files,
        network=network,
        remote_group=remote_group,
        service_ids=dict(service_ids or {}),
    )


def shell_join(parts: Sequence[str]) -> str:
    return " ".join(shlex.quote(str(part)) for part in parts)


class Runner:
    def __init__(self, host: str, user: str, port: int, verbose: bool = False):
        self.host = host
        self.user = user
        self.port = port
        self.verbose = verbose

    @property
    def target(self) -> str:
        return f"{self.user}@{self.host}"

    def _run(
        self,
        command: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        capture: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        if self.verbose:
            print("+", shell_join(command), file=sys.stderr)
        completed = subprocess.run(
            list(command),
            cwd=cwd,
            env=dict(env) if env is not None else None,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=capture,
            check=False,
        )
        if completed.returncode:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise DeploymentError(
                f"command failed ({completed.returncode}): {command[0]}"
                + (f"\n{detail}" if detail else "")
            )
        return completed

    def local(
        self,
        command: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        capture: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        return self._run(command, cwd=cwd, env=env, capture=capture)

    def ssh(self, script: str, *, capture: bool = True) -> str:
        command = [
            "ssh",
            "-p",
            str(self.port),
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=accept-new",
            self.target,
            "--",
            "sh",
            "-lc",
            shlex.quote(script),
        ]
        return self._run(command, capture=capture).stdout

    def upload(self, source: Path, destination: str) -> None:
        command = [
            "scp",
            "-P",
            str(self.port),
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=accept-new",
            str(source),
            f"{self.target}:{destination}",
        ]
        self._run(command)


def parse_service_ids(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0] and parts[1]:
            result[parts[1]] = parts[0]
    return result


def discover_remote(runner: Runner, container: str) -> RemoteState:
    print(f"[preflight] inspecting {runner.target}:{container}")
    runner.ssh(
        "set -eu; "
        "command -v sudo >/dev/null; "
        "command -v docker >/dev/null; "
        "command -v python3 >/dev/null; "
        "command -v curl >/dev/null; "
        "command -v sha256sum >/dev/null; "
        "sudo -n true"
    )
    docker_version = runner.ssh(
        "sudo docker version --format '{{.Server.Version}}'"
    ).strip()
    free_text = runner.ssh(
        "df -Pk / | awk 'NR == 2 { print $4 }'"
    ).strip()
    try:
        free_kib = int(free_text)
    except ValueError as exc:
        raise DeploymentError(
            f"cannot parse remote free disk space: {free_text!r}"
        ) from exc
    if free_kib < MIN_REMOTE_FREE_KIB:
        raise DeploymentError(
            "remote root filesystem has less than 2 GiB free "
            f"({free_kib / 1024 / 1024:.2f} GiB)"
        )
    print(
        f"[preflight] Docker {docker_version}; "
        f"remote free space {free_kib / 1024 / 1024:.1f} GiB"
    )
    remote_group = runner.ssh("id -gn").strip()
    inspect_payload = runner.ssh(
        f"sudo docker inspect {shlex.quote(container)}"
    )
    initial = parse_remote_state(
        inspect_payload,
        container=container,
        remote_group=remote_group,
    )
    service_text = runner.ssh(
        "sudo docker ps "
        f"--filter {shlex.quote('label=com.docker.compose.project=' + initial.project)} "
        "--format '{{.ID}} {{.Label \"com.docker.compose.service\"}}'"
    )
    return parse_remote_state(
        inspect_payload,
        container=container,
        remote_group=remote_group,
        service_ids=parse_service_ids(service_text),
    )


def make_release_name() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-web-r1")


def make_plan(state: RemoteState, release: str, public_url: str) -> ReleasePlan:
    release = validate_release(release)
    image = f"minerats-web:release-{release}"
    if not IMAGE_RE.fullmatch(image):
        raise DeploymentError(f"generated image name is unsafe: {image!r}")
    release_dir = str(PurePosixPath(state.releases_root) / release)
    return ReleasePlan(
        release=release,
        image=image,
        release_dir=release_dir,
        override=str(PurePosixPath(release_dir) / "production-compose.override.yml"),
        remote_archive=f"/tmp/minerats-web-{release}.tar.gz",
        public_url=public_url,
    )


def print_state(state: RemoteState) -> None:
    print("[preflight] remote state")
    print(f"  project:          {state.project}")
    print(f"  service:          {state.service}")
    print(f"  current image:    {state.image}")
    print(f"  working dir:      {state.working_dir}")
    print(f"  base compose:     {state.base_compose}")
    print(f"  current override: {state.current_override}")
    print(f"  network:          {state.network}")
    if state.service_ids:
        formatted = ", ".join(
            f"{service}={container_id[:12]}"
            for service, container_id in sorted(state.service_ids.items())
        )
        print(f"  containers:       {formatted}")


def print_deploy_plan(state: RemoteState, plan: ReleasePlan, execute: bool) -> None:
    print_state(state)
    print("[plan] Web-only deployment")
    print(f"  mode:             {'EXECUTE' if execute else 'DRY RUN (read-only)'}")
    print(f"  release:          {plan.release}")
    print(f"  new image:        {plan.image}")
    print(f"  release dir:      {plan.release_dir}")
    print(f"  public URL:       {plan.public_url}")
    print("  switch:           docker compose up -d --no-deps web")
    print(f"  rollback source:  {state.current_override}")


def find_python() -> str:
    candidates = [
        REPO_ROOT / "backend" / ".venv" / "Scripts" / "python.exe",
        REPO_ROOT / "backend" / ".venv" / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def find_npm() -> str:
    command = "npm.cmd" if os.name == "nt" else "npm"
    found = shutil.which(command)
    if not found:
        raise DeploymentError("npm was not found")
    return found


def run_local_checks(runner: Runner) -> None:
    print("[local] running Web tests")
    npm = find_npm()
    runner.local([npm, "--prefix", "web", "test"], cwd=REPO_ROOT)
    print("[local] building Web dist")
    runner.local([npm, "--prefix", "web", "run", "build"], cwd=REPO_ROOT)
    print("[local] checking deployment contracts")
    runner.local(
        [
            find_python(),
            "-m",
            "unittest",
            "backend.tests.test_deployment_contracts",
        ],
        cwd=REPO_ROOT,
    )


def archive_filter(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    normalized = info.name.replace("\\", "/").lstrip("./")
    if (
        normalized in SAFE_ARCHIVE_ROOTS
        or normalized.startswith("LICENSES/")
        or normalized.startswith("web/dist/")
    ):
        info.name = normalized
        return info
    return None


def create_archive(output: Path) -> str:
    required = [
        REPO_ROOT / "Dockerfile.web-dist",
        REPO_ROOT / "LICENSE",
        REPO_ROOT / "THIRD_PARTY_NOTICES.md",
        REPO_ROOT / "LICENSES",
        REPO_ROOT / "docker" / "nginx-web.conf",
        REPO_ROOT / "web" / "dist",
        REPO_ROOT / "scripts" / "verify_deployment.py",
    ]
    missing = [str(path.relative_to(REPO_ROOT)) for path in required if not path.exists()]
    if missing:
        raise DeploymentError("release files are missing: " + ", ".join(missing))

    with tarfile.open(output, "w:gz") as archive:
        for path in required:
            archive.add(
                path,
                arcname=path.relative_to(REPO_ROOT).as_posix(),
                recursive=True,
                filter=archive_filter,
            )
    digest = hashlib.sha256()
    with output.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def python_replace_command() -> str:
    code = (
        "from pathlib import Path; import sys; "
        "p=Path(sys.argv[1]); old=sys.argv[2]; new=sys.argv[3]; "
        "s=p.read_text(); "
        "n=s.count(old); "
        "assert n == 1, f'expected one old Web image, found {n}'; "
        "p.write_text(s.replace(old,new))"
    )
    return shell_join(["python3", "-c", code])


def compose_command(state: RemoteState, override: str, *args: str) -> str:
    return shell_join(
        [
            "sudo",
            "docker",
            "compose",
            "-f",
            state.base_compose,
            "-f",
            override,
            *args,
        ]
    )


def build_deploy_script(
    state: RemoteState,
    plan: ReleasePlan,
    *,
    user: str,
    archive_sha256: str,
) -> str:
    q = shlex.quote
    compose_new = compose_command(state, plan.override)
    compose_old = compose_command(state, state.current_override)
    replace = python_replace_command()
    expected_non_web = "\n".join(
        f"{service} {container_id}"
        for service, container_id in sorted(state.service_ids.items())
        if service != "web"
    )
    manifest = json.dumps(
        {
            "release": plan.release,
            "image": plan.image,
            "previous_image": state.image,
            "previous_override": state.current_override,
            "archive_sha256": archive_sha256,
            "compose_project": state.project,
            "compose_service": state.service,
            "prepared_at": datetime.now().astimezone().isoformat(),
            "status": "prepared",
        },
        ensure_ascii=False,
        indent=2,
    )
    manifest_update = shell_join(
        [
            "python3",
            "-c",
            (
                "import datetime,json,sys; "
                "p=sys.argv[1]; "
                "d=json.load(open(p,encoding='utf-8')); "
                "d['status']='deployed'; "
                "d['deployed_at']=datetime.datetime.now().astimezone().isoformat(); "
                "open(p,'w',encoding='utf-8').write("
                "json.dumps(d,ensure_ascii=False,indent=2)+'\\n')"
            ),
        ]
    )
    return f"""set -eu
release_dir={q(plan.release_dir)}
build_dir={q(plan.release_dir + "/build-context")}
archive={q(plan.remote_archive)}
new_override={q(plan.override)}
old_override={q(state.current_override)}
old_image={q(state.image)}
new_image={q(plan.image)}
container={q(state.container)}
network={q(state.network)}
working_dir={q(state.working_dir)}
probe={q("minerats-web-probe-" + plan.release)}
switched=0
complete=0

cleanup() {{
  sudo docker rm -f "$probe" >/dev/null 2>&1 || true
  rm -f "$archive" || true
  if [ "$switched" = 1 ] && [ "$complete" != 1 ]; then
    echo "[rollback] restoring the previous Web override" >&2
    cd "$working_dir"
    {compose_old} up -d --no-deps web || true
  fi
}}
trap cleanup EXIT HUP INT TERM

[ ! -e "$release_dir" ] || {{ echo "release directory already exists: $release_dir" >&2; exit 1; }}
printf '%s  %s\\n' {q(archive_sha256)} "$archive" | sha256sum -c -
sudo install -d -o {q(user)} -g {q(state.remote_group)} "$release_dir" "$build_dir"
tar -xzf "$archive" -C "$build_dir"
sudo docker inspect "$container" | sudo tee "$release_dir/predeploy-web-container.json" >/dev/null
cd "$working_dir"
{compose_old} config -q
{compose_old} config | sudo tee "$release_dir/predeploy-compose-config.yml" >/dev/null
sudo cp "$old_override" "$new_override"
sudo chown {q(user + ":" + state.remote_group)} "$new_override"
{replace} "$new_override" "$old_image" "$new_image"
cat > "$release_dir/release-manifest.json" <<'TSBOT_MANIFEST'
{manifest}
TSBOT_MANIFEST

cat > "$release_dir/predeploy-non-web-containers.txt" <<'TSBOT_CONTAINERS'
{expected_non_web}
TSBOT_CONTAINERS

cd "$build_dir"
sudo docker build --pull=false \
  --label {q("org.opencontainers.image.version=" + plan.release)} \
  --label {q("io.minerats.previous-image=" + state.image)} \
  -f Dockerfile.web-dist -t "$new_image" .

sudo docker run -d --rm --name "$probe" --network "$network" \
  -p 127.0.0.1::8080 "$new_image" >/dev/null
probe_port=""
i=0
while [ "$i" -lt 30 ]; do
  probe_port="$(sudo docker port "$probe" 8080/tcp 2>/dev/null | sed -n 's/.*://p' | head -n 1)"
  if [ -n "$probe_port" ] && curl -fsS "http://127.0.0.1:$probe_port/" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ -n "$probe_port" ] || {{ echo "probe port was not assigned" >&2; exit 1; }}
python3 scripts/verify_deployment.py \
  --base-url "http://127.0.0.1:$probe_port" --json
sudo docker rm -f "$probe" >/dev/null

cd "$working_dir"
{compose_new} config -q
switched=1
{compose_new} up -d --no-deps web
[ "$(sudo docker inspect --format '{{{{.Config.Image}}}}' "$container")" = "$new_image" ]
[ "$(sudo docker inspect --format '{{{{.State.Running}}}}' "$container")" = true ]
sudo docker exec "$container" wget -qO- http://127.0.0.1:8080/ >/dev/null

while read -r service expected_id; do
  [ -n "$service" ] || continue
  actual_id="$(sudo docker ps -q \
    --filter {q("label=com.docker.compose.project=" + state.project)} \
    --filter "label=com.docker.compose.service=$service")"
  [ "$actual_id" = "$expected_id" ] || {{
    echo "non-Web container changed: $service" >&2
    exit 1
  }}
done < "$release_dir/predeploy-non-web-containers.txt"

complete=1
{manifest_update} "$release_dir/release-manifest.json"
echo "[remote] Web switch completed: $new_image"
"""


def read_target_image(runner: Runner, state: RemoteState, override: str) -> str:
    command = compose_command(
        state,
        override,
        "config",
        "--format",
        "json",
    )
    payload = runner.ssh(
        f"set -eu; sudo test -r {shlex.quote(override)}; {command}"
    )
    try:
        image = str(json.loads(payload)["services"]["web"]["image"])
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise DeploymentError(
            f"cannot resolve the Web image from {override}: {exc}"
        ) from exc
    if not IMAGE_RE.fullmatch(image):
        raise DeploymentError(f"unsafe target image: {image!r}")
    return image


def build_rollback_script(
    state: RemoteState,
    *,
    target_override: str,
    target_image: str,
) -> str:
    q = shlex.quote
    compose_target = compose_command(state, target_override)
    compose_current = compose_command(state, state.current_override)
    expected_non_web = "\n".join(
        f"{service} {container_id}"
        for service, container_id in sorted(state.service_ids.items())
        if service != "web"
    )
    return f"""set -eu
container={q(state.container)}
working_dir={q(state.working_dir)}
target_image={q(target_image)}
complete=0

restore() {{
  if [ "$complete" != 1 ]; then
    echo "[rollback] target failed; restoring the starting override" >&2
    cd "$working_dir"
    {compose_current} up -d --no-deps web || true
  fi
}}
trap restore EXIT HUP INT TERM

cat > /tmp/minerats-rollback-non-web-$$.txt <<'TSBOT_CONTAINERS'
{expected_non_web}
TSBOT_CONTAINERS
ids_file=/tmp/minerats-rollback-non-web-$$.txt
trap 'rm -f "$ids_file"; restore' EXIT HUP INT TERM

cd "$working_dir"
{compose_target} config -q
{compose_target} up -d --no-deps web
[ "$(sudo docker inspect --format '{{{{.Config.Image}}}}' "$container")" = "$target_image" ]
[ "$(sudo docker inspect --format '{{{{.State.Running}}}}' "$container")" = true ]
sudo docker exec "$container" wget -qO- http://127.0.0.1:8080/ >/dev/null

while read -r service expected_id; do
  [ -n "$service" ] || continue
  actual_id="$(sudo docker ps -q \
    --filter {q("label=com.docker.compose.project=" + state.project)} \
    --filter "label=com.docker.compose.service=$service")"
  [ "$actual_id" = "$expected_id" ] || {{
    echo "non-Web container changed: $service" >&2
    exit 1
  }}
done < "$ids_file"

complete=1
rm -f "$ids_file"
echo "[remote] Web rollback completed: $target_image"
"""


def run_acceptance(
    runner: Runner,
    public_url: str,
    *,
    with_browser: bool,
) -> dict[str, Any]:
    print(
        "[acceptance] running protocol"
        + (" and browser" if with_browser else "")
        + " checks"
    )
    command = [
        find_python(),
        str(REPO_ROOT / "scripts" / "verify_deployment.py"),
        "--base-url",
        public_url,
        "--json",
    ]
    if with_browser:
        command.append("--with-browser")
    environment = os.environ.copy()
    completed = runner.local(
        command,
        cwd=REPO_ROOT,
        env=environment,
        capture=True,
    )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError:
        result = {"raw_output": completed.stdout.strip(), "success": True}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def write_report(
    release: str,
    *,
    operation: str,
    state: RemoteState,
    target_image: str,
    public_url: str,
    acceptance: Mapping[str, Any],
) -> Path:
    report_dir = REPO_ROOT / "artifacts" / "releases" / release
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / f"{operation}-report.json"
    payload = {
        "operation": operation,
        "release": release,
        "recorded_at": datetime.now().astimezone().isoformat(),
        "public_url": public_url,
        "starting_state": asdict(state),
        "target_image": target_image,
        "acceptance": acceptance,
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def restore_override(runner: Runner, state: RemoteState, override: str) -> None:
    print(f"[rollback] restoring {override}", file=sys.stderr)
    command = compose_command(state, override, "up", "-d", "--no-deps", "web")
    runner.ssh(f"set -eu; cd {shlex.quote(state.working_dir)}; {command}")


def run_acceptance_or_restore(
    runner: Runner,
    state: RemoteState,
    public_url: str,
    *,
    with_browser: bool,
    failure_message: str,
) -> dict[str, Any]:
    """Run post-switch acceptance and restore the starting override on failure."""
    try:
        return run_acceptance(
            runner,
            public_url,
            with_browser=with_browser,
        )
    except DeploymentError as exc:
        restore_override(runner, state, state.current_override)
        raise DeploymentError(failure_message) from exc


def deploy(args: argparse.Namespace, runner: Runner) -> int:
    state = discover_remote(runner, args.container)
    public_url = args.public_url or f"http://{args.host}:8080"
    public_url = normalize_public_url(public_url)
    plan = make_plan(state, args.release or make_release_name(), public_url)
    print_deploy_plan(state, plan, args.execute)
    if not args.execute:
        print("\nDry run complete. Re-run with --execute to perform this exact workflow.")
        return 0

    if not args.skip_local_checks:
        run_local_checks(runner)

    with tempfile.TemporaryDirectory(prefix="minerats-web-release-") as temp_dir:
        archive = Path(temp_dir) / f"{plan.release}.tar.gz"
        archive_sha256 = create_archive(archive)
        print(f"[package] sha256={archive_sha256}")
        runner.upload(archive, plan.remote_archive)
        remote_script = build_deploy_script(
            state,
            plan,
            user=args.user,
            archive_sha256=archive_sha256,
        )
        runner.ssh(remote_script, capture=False)

    acceptance = run_acceptance_or_restore(
        runner,
        state,
        plan.public_url,
        with_browser=not args.skip_browser,
        failure_message=(
            "post-deploy acceptance failed; "
            "the previous Web override was restored"
        ),
    )

    report = write_report(
        plan.release,
        operation="deploy",
        state=state,
        target_image=plan.image,
        public_url=plan.public_url,
        acceptance=acceptance,
    )
    print(f"[done] deployment report: {report}")
    wrapper = ".\\deploy-web.ps1" if os.name == "nt" else "./deploy-web.sh"
    print(
        f"[done] rollback command: {wrapper} rollback "
        f"--host {args.host} "
        f"--release {PurePosixPath(state.current_override).parent.name} --execute"
    )
    return 0


def rollback(args: argparse.Namespace, runner: Runner) -> int:
    state = discover_remote(runner, args.container)
    public_url = normalize_public_url(
        args.public_url or f"http://{args.host}:8080"
    )
    target_override = str(
        PurePosixPath(state.releases_root)
        / args.release
        / "production-compose.override.yml"
    )
    target_image = read_target_image(runner, state, target_override)
    print_state(state)
    print("[plan] Web-only rollback")
    print(f"  mode:             {'EXECUTE' if args.execute else 'DRY RUN (read-only)'}")
    print(f"  target release:   {args.release}")
    print(f"  target image:     {target_image}")
    print(f"  target override:  {target_override}")
    print(f"  restore on error: {state.current_override}")
    if not args.execute:
        print("\nDry run complete. Re-run with --execute to perform this rollback.")
        return 0
    if target_override == state.current_override:
        raise DeploymentError("the requested release is already active")

    script = build_rollback_script(
        state,
        target_override=target_override,
        target_image=target_image,
    )
    runner.ssh(script, capture=False)
    acceptance = run_acceptance_or_restore(
        runner,
        state,
        public_url,
        with_browser=not args.skip_browser,
        failure_message=(
            "rollback-target acceptance failed; "
            "the starting Web override was restored"
        ),
    )

    report = write_report(
        args.release,
        operation="rollback",
        state=state,
        target_image=target_image,
        public_url=public_url,
        acceptance=acceptance,
    )
    print(f"[done] rollback report: {report}")
    return 0


def add_connection_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--host",
        type=validate_host,
        default=os.environ.get("TSBOT_DEPLOY_HOST"),
        help="SSH host (or TSBOT_DEPLOY_HOST)",
    )
    parser.add_argument(
        "--user",
        type=validate_user,
        default=os.environ.get("TSBOT_DEPLOY_USER", "ubuntu"),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("TSBOT_DEPLOY_PORT", "22")),
    )
    parser.add_argument(
        "--container",
        type=validate_container,
        default=os.environ.get("TSBOT_DEPLOY_WEB_CONTAINER", DEFAULT_CONTAINER),
    )
    parser.add_argument(
        "--public-url",
        type=normalize_public_url,
        default=os.environ.get("TSBOT_DEPLOY_PUBLIC_URL"),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--execute",
        action="store_true",
        help="allow remote writes and a Web-only Compose switch",
    )
    mode.add_argument(
        "--dry-run",
        action="store_false",
        dest="execute",
        help="perform only read-only remote discovery (the default)",
    )
    parser.set_defaults(execute=False)
    parser.add_argument(
        "--skip-browser",
        action="store_true",
        help="skip browser acceptance after the switch (not recommended)",
    )
    parser.add_argument("--verbose", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Safely deploy or roll back only the TSBot Web service. "
            "The default is a read-only dry run."
        )
    )
    subparsers = parser.add_subparsers(dest="operation", required=True)

    deploy_parser = subparsers.add_parser(
        "deploy",
        help="build, probe and switch to a new Web release",
    )
    add_connection_arguments(deploy_parser)
    deploy_parser.add_argument("--release", type=validate_release)
    deploy_parser.add_argument(
        "--skip-local-checks",
        action="store_true",
        help="skip Web tests/build contracts before packaging (not recommended)",
    )

    rollback_parser = subparsers.add_parser(
        "rollback",
        help="switch Web to an existing release override",
    )
    add_connection_arguments(rollback_parser)
    rollback_parser.add_argument("--release", type=validate_release, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.host:
        parser.error("--host or TSBOT_DEPLOY_HOST is required")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    runner = Runner(args.host, args.user, args.port, verbose=args.verbose)
    try:
        if args.operation == "deploy":
            return deploy(args, runner)
        return rollback(args, runner)
    except (DeploymentError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
