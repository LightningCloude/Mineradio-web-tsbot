#!/usr/bin/env python3
"""Run destructive Web deployment failure drills in an isolated Compose project.

This script never targets the production Compose project. It creates uniquely
named resources below /tmp/minerats-deploy-drill-*, exercises the real release
command builders, records assertions, and removes those resources afterward.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import tarfile
import tempfile
from typing import Any

import deploy_web


REPO_ROOT = Path(__file__).resolve().parents[1]
DRILL_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$")
DRILL_ROOT_PREFIX = "/tmp/minerats-deploy-drill-"


class DrillError(RuntimeError):
    """An isolated drill assertion failed."""


def make_drill_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)


def validate_drill_id(value: str) -> str:
    if not DRILL_ID_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "drill ID must look like 20260730-210000-a1b2c3"
        )
    return value


def drill_names(drill_id: str) -> dict[str, str]:
    validate_drill_id(drill_id)
    short = drill_id.replace("-", "")
    root = f"{DRILL_ROOT_PREFIX}{drill_id}"
    return {
        "root": root,
        "stack": f"{root}/stack",
        "releases": f"{root}/releases",
        "bootstrap": f"{root}/releases/bootstrap",
        "base": f"{root}/stack/compose.yml",
        "old_override": (
            f"{root}/releases/bootstrap/production-compose.override.yml"
        ),
        "broken_override": (
            f"{root}/releases/broken/production-compose.override.yml"
        ),
        "project": f"minerats-drill-{short}",
        "web_container": f"minerats-drill-{short}-web",
        "old_image": f"minerats-web-drill:{short}-old",
        "broken_image": f"minerats-web-drill:{short}-broken",
    }


def validate_image(value: str) -> str:
    if not deploy_web.IMAGE_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"invalid Docker image: {value!r}")
    return value


def setup_script(
    names: dict[str, str],
    user: str,
    base_image: str,
) -> str:
    q = shlex.quote
    root = names["root"]
    if not root.startswith(DRILL_ROOT_PREFIX):
        raise DrillError(f"refusing unsafe drill root: {root}")
    group_marker = "__DRILL_GROUP__"
    compose = f"""name: {names["project"]}
services:
  voice-service:
    image: {base_image}
    command: ["sh", "-c", "sleep 3600"]
  backend:
    image: {base_image}
    command: ["sh", "-c", "sleep 3600"]
  web:
    image: {names["old_image"]}
    container_name: {names["web_container"]}
"""
    old_override = f"""services:
  web:
    image: {names["old_image"]}
"""
    broken_override = f"""services:
  web:
    image: {names["broken_image"]}
"""
    nginx_config = """server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    location / { try_files $uri $uri/ /index.html; }
}
"""
    old_dockerfile = f"""FROM {base_image}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
"""
    broken_dockerfile = f"""FROM {base_image}
CMD ["sh", "-c", "sleep 3600"]
"""
    return f"""set -eu
root={q(root)}
[ ! -e "$root" ] || {{ echo "drill root already exists: $root" >&2; exit 1; }}
group="$(id -gn)"
sudo install -d -o {q(user)} -g "$group" \
  {q(names["stack"])} {q(names["bootstrap"])} \
  {q(str(PurePosixPath(names["broken_override"]).parent))} \
  {q(names["stack"] + "/old-image")} {q(names["stack"] + "/broken-image")}

cat > {q(names["base"])} <<'DRILL_COMPOSE'
{compose}DRILL_COMPOSE
cat > {q(names["old_override"])} <<'DRILL_OLD_OVERRIDE'
{old_override}DRILL_OLD_OVERRIDE
cat > {q(names["broken_override"])} <<'DRILL_BROKEN_OVERRIDE'
{broken_override}DRILL_BROKEN_OVERRIDE
cat > {q(names["stack"] + "/old-image/nginx.conf")} <<'DRILL_NGINX'
{nginx_config}DRILL_NGINX
cat > {q(names["stack"] + "/old-image/index.html")} <<'DRILL_INDEX'
<!doctype html><title>old</title><p>drill-old</p>
DRILL_INDEX
cat > {q(names["stack"] + "/old-image/Dockerfile")} <<'DRILL_OLD_DOCKERFILE'
{old_dockerfile}DRILL_OLD_DOCKERFILE
cat > {q(names["stack"] + "/broken-image/Dockerfile")} <<'DRILL_BROKEN_DOCKERFILE'
{broken_dockerfile}DRILL_BROKEN_DOCKERFILE

sudo docker image inspect {q(base_image)} >/dev/null
sudo docker build --pull=false -t {q(names["old_image"])} \
  -f {q(names["stack"] + "/old-image/Dockerfile")} \
  {q(names["stack"] + "/old-image")}
sudo docker build --pull=false -t {q(names["broken_image"])} \
  -f {q(names["stack"] + "/broken-image/Dockerfile")} \
  {q(names["stack"] + "/broken-image")}
cd {q(names["stack"])}
sudo docker compose -f {q(names["base"])} -f {q(names["old_override"])} \
  up -d
echo "[drill] isolated project started: {names["project"]}"
""".replace(group_marker, "")


def cleanup_script(names: dict[str, str]) -> str:
    q = shlex.quote
    root = names["root"]
    if not root.startswith(DRILL_ROOT_PREFIX) or not DRILL_ID_RE.fullmatch(
        root.removeprefix(DRILL_ROOT_PREFIX)
    ):
        raise DrillError(f"refusing unsafe cleanup root: {root}")
    image_prefix = names["old_image"].rsplit(":", 1)[0] + ":"
    if image_prefix != "minerats-web-drill:":
        raise DrillError(f"refusing unsafe image prefix: {image_prefix}")
    return f"""set -eu
root={q(root)}
if [ -f {q(names["base"])} ]; then
  cd {q(names["stack"])}
  sudo docker compose -f {q(names["base"])} down --remove-orphans \
    >/dev/null 2>&1 || true
fi
sudo docker rm -f {q(names["web_container"])} >/dev/null 2>&1 || true
for image in $(sudo docker image ls --format '{{{{.Repository}}}}:{{{{.Tag}}}}' \
  --filter reference='minerats-web-drill:*'); do
  case "$image" in
    {q("minerats-web-drill:" + names["project"].removeprefix("minerats-drill-"))}*)
      sudo docker image rm -f "$image" >/dev/null 2>&1 || true
      ;;
  esac
done
if [ -d "$root" ]; then
  sudo rm -rf -- "$root"
fi
echo "[drill] isolated resources removed: {names["project"]}"
"""


def create_drill_archive(
    output: Path,
    *,
    base_image: str,
    marker: str,
    verifier_succeeds: bool,
) -> str:
    with tempfile.TemporaryDirectory(prefix="minerats-drill-context-") as temp:
        root = Path(temp)
        (root / "docker").mkdir()
        (root / "web" / "dist").mkdir(parents=True)
        (root / "scripts").mkdir()
        (root / "Dockerfile.web-dist").write_text(
            f"FROM {base_image}\n"
            "COPY docker/nginx-web.conf /etc/nginx/conf.d/default.conf\n"
            "COPY web/dist /usr/share/nginx/html\n",
            encoding="utf-8",
        )
        (root / "docker" / "nginx-web.conf").write_text(
            "server {\n"
            "  listen 8080;\n"
            "  server_name _;\n"
            "  root /usr/share/nginx/html;\n"
            "  location / { try_files $uri $uri/ /index.html; }\n"
            "}\n",
            encoding="utf-8",
        )
        (root / "web" / "dist" / "index.html").write_text(
            f"<!doctype html><title>{marker}</title><p>{marker}</p>\n",
            encoding="utf-8",
        )
        verifier = (
            "import argparse,json,urllib.request\n"
            "p=argparse.ArgumentParser();"
            "p.add_argument('--base-url',required=True);"
            "p.add_argument('--json',action='store_true');"
            "a=p.parse_args();"
            f"body=urllib.request.urlopen(a.base_url,timeout=5).read();"
            f"assert {marker.encode()!r} in body;"
            "print(json.dumps({'ok':True,'drill':True}))\n"
            if verifier_succeeds
            else "raise SystemExit('injected probe verification failure')\n"
        )
        (root / "scripts" / "verify_deployment.py").write_text(
            verifier,
            encoding="utf-8",
        )
        with tarfile.open(output, "w:gz") as archive:
            for relative in (
                "Dockerfile.web-dist",
                "docker/nginx-web.conf",
                "web/dist",
                "scripts/verify_deployment.py",
            ):
                archive.add(root / relative, arcname=relative)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return digest


def make_drill_plan(
    state: deploy_web.RemoteState,
    names: dict[str, str],
    release: str,
    image_suffix: str,
) -> deploy_web.ReleasePlan:
    deploy_web.validate_release(release)
    short = names["project"].removeprefix("minerats-drill-")
    image = f"minerats-web-drill:{short}-{image_suffix}"
    if not deploy_web.IMAGE_RE.fullmatch(image):
        raise DrillError(f"unsafe generated drill image: {image}")
    release_dir = str(PurePosixPath(state.releases_root) / release)
    return deploy_web.ReleasePlan(
        release=release,
        image=image,
        release_dir=release_dir,
        override=f"{release_dir}/production-compose.override.yml",
        remote_archive=f"{names['root']}/minerats-web-{release}.tar.gz",
        public_url="http://127.0.0.1",
    )


def assert_non_web_unchanged(
    initial: deploy_web.RemoteState,
    current: deploy_web.RemoteState,
) -> None:
    for service, initial_id in initial.service_ids.items():
        if service == "web":
            continue
        actual = current.service_ids.get(service)
        if actual != initial_id:
            raise DrillError(
                f"non-Web container changed: {service} "
                f"{initial_id!r} -> {actual!r}"
            )


def expect_remote_failure(runner: deploy_web.Runner, script: str, label: str) -> None:
    try:
        runner.ssh(script, capture=False)
    except deploy_web.DeploymentError:
        print(f"[pass] {label}: expected failure observed")
        return
    raise DrillError(f"{label}: command unexpectedly succeeded")


def upload_and_run_release(
    runner: deploy_web.Runner,
    state: deploy_web.RemoteState,
    plan: deploy_web.ReleasePlan,
    *,
    user: str,
    base_image: str,
    marker: str,
    verifier_succeeds: bool,
    expect_failure: bool,
) -> None:
    with tempfile.TemporaryDirectory(prefix="minerats-drill-release-") as temp:
        archive = Path(temp) / f"{plan.release}.tar.gz"
        digest = create_drill_archive(
            archive,
            base_image=base_image,
            marker=marker,
            verifier_succeeds=verifier_succeeds,
        )
        runner.upload(archive, plan.remote_archive)
        script = deploy_web.build_deploy_script(
            state,
            plan,
            user=user,
            archive_sha256=digest,
        )
        if expect_failure:
            expect_remote_failure(runner, script, "probe failure")
        else:
            runner.ssh(script, capture=False)


def run_drills(
    runner: deploy_web.Runner,
    *,
    user: str,
    base_image: str,
    drill_id: str,
) -> dict[str, Any]:
    names = drill_names(drill_id)
    results: list[dict[str, Any]] = []
    runner.ssh(setup_script(names, user, base_image), capture=False)
    initial = deploy_web.discover_remote(runner, names["web_container"])
    if initial.project != names["project"] or initial.image != names["old_image"]:
        raise DrillError("isolated project discovery returned unexpected state")

    probe_release = f"{drill_id}-probe-failure"
    probe_plan = make_drill_plan(
        initial,
        names,
        probe_release,
        "probe-failure",
    )
    upload_and_run_release(
        runner,
        initial,
        probe_plan,
        user=user,
        base_image=base_image,
        marker="probe-failure",
        verifier_succeeds=False,
        expect_failure=True,
    )
    after_probe = deploy_web.discover_remote(runner, names["web_container"])
    assert_non_web_unchanged(initial, after_probe)
    if (
        after_probe.image != names["old_image"]
        or after_probe.container_id != initial.container_id
    ):
        raise DrillError("probe failure changed the active Web container")
    results.append(
        {
            "scenario": "probe_failure_does_not_switch",
            "status": "pass",
            "web_container_unchanged": True,
            "non_web_containers_unchanged": True,
        }
    )
    print("[pass] probe failure left every active container unchanged")

    success_release = f"{drill_id}-post-acceptance"
    success_plan = make_drill_plan(
        after_probe,
        names,
        success_release,
        "post-acceptance",
    )
    upload_and_run_release(
        runner,
        after_probe,
        success_plan,
        user=user,
        base_image=base_image,
        marker="drill-new",
        verifier_succeeds=True,
        expect_failure=False,
    )
    switched = deploy_web.discover_remote(runner, names["web_container"])
    assert_non_web_unchanged(initial, switched)
    if switched.image != success_plan.image:
        raise DrillError("successful isolated switch did not activate the new image")
    if switched.container_id == initial.container_id:
        raise DrillError("successful isolated switch did not recreate Web")

    original_acceptance = deploy_web.run_acceptance

    def injected_failure(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise deploy_web.DeploymentError("injected post-switch acceptance failure")

    deploy_web.run_acceptance = injected_failure
    try:
        try:
            deploy_web.run_acceptance_or_restore(
                runner,
                after_probe,
                "http://127.0.0.1",
                with_browser=True,
                failure_message="injected acceptance failed; restored",
            )
        except deploy_web.DeploymentError:
            pass
        else:
            raise DrillError("injected post-switch acceptance unexpectedly passed")
    finally:
        deploy_web.run_acceptance = original_acceptance

    restored = deploy_web.discover_remote(runner, names["web_container"])
    assert_non_web_unchanged(initial, restored)
    if restored.image != names["old_image"]:
        raise DrillError("post-switch acceptance failure did not restore old Web")
    results.append(
        {
            "scenario": "post_acceptance_failure_restores_starting_override",
            "status": "pass",
            "new_web_was_started": True,
            "old_web_restored": True,
            "non_web_containers_unchanged": True,
        }
    )
    print("[pass] injected post-switch acceptance failure restored old Web")

    deploy_web.restore_override(runner, restored, success_plan.override)
    rollback_start = deploy_web.discover_remote(runner, names["web_container"])
    if rollback_start.image != success_plan.image:
        raise DrillError("could not prepare the rollback-failure starting state")
    target_image = deploy_web.read_target_image(
        runner,
        rollback_start,
        names["broken_override"],
    )
    rollback_script = deploy_web.build_rollback_script(
        rollback_start,
        target_override=names["broken_override"],
        target_image=target_image,
    )
    expect_remote_failure(
        runner,
        rollback_script,
        "broken rollback target",
    )
    after_rollback_failure = deploy_web.discover_remote(
        runner,
        names["web_container"],
    )
    assert_non_web_unchanged(initial, after_rollback_failure)
    if after_rollback_failure.image != success_plan.image:
        raise DrillError("broken rollback target did not restore starting Web")
    results.append(
        {
            "scenario": "broken_rollback_target_restores_starting_override",
            "status": "pass",
            "starting_web_restored": True,
            "non_web_containers_unchanged": True,
        }
    )
    print("[pass] broken rollback target restored its starting Web release")

    return {
        "ok": True,
        "drill_id": drill_id,
        "project": names["project"],
        "remote_root": names["root"],
        "base_image": base_image,
        "results": results,
        "production_project_used": False,
    }


def write_report(drill_id: str, result: dict[str, Any]) -> Path:
    target = REPO_ROOT / "artifacts" / "deployment-drills" / drill_id
    target.mkdir(parents=True, exist_ok=True)
    path = target / "result.json"
    path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Exercise Web deployment failure recovery in a unique isolated "
            "Compose project. Default mode only prints the plan."
        )
    )
    parser.add_argument(
        "--host",
        type=deploy_web.validate_host,
        default=os.environ.get("TSBOT_DEPLOY_HOST"),
    )
    parser.add_argument(
        "--user",
        type=deploy_web.validate_user,
        default=os.environ.get("TSBOT_DEPLOY_USER", "ubuntu"),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("TSBOT_DEPLOY_PORT", "22")),
    )
    parser.add_argument("--drill-id", type=validate_drill_id)
    parser.add_argument(
        "--base-image",
        type=validate_image,
        default=os.environ.get("TSBOT_DRILL_BASE_IMAGE"),
        help="existing remote nginx-compatible image; never pulled by the drill",
    )
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.host:
        parser.error("--host or TSBOT_DEPLOY_HOST is required")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.execute and not args.base_image:
        parser.error("--base-image or TSBOT_DRILL_BASE_IMAGE is required with --execute")
    drill_id = args.drill_id or make_drill_id()
    names = drill_names(drill_id)
    print("[plan] isolated Web deployment failure drill")
    print(f"  mode:       {'EXECUTE' if args.execute else 'DRY RUN'}")
    print(f"  SSH target: {args.user}@{args.host}:{args.port}")
    print(f"  project:    {names['project']}")
    print(f"  remote dir: {names['root']}")
    print(f"  base image: {args.base_image or '<required for --execute>'}")
    print("  ports:      none published")
    print("  production: Compose project and containers are not referenced")
    print("  cleanup:    always attempted")
    if not args.execute:
        print("\nDry run complete. Add --execute to create isolated resources.")
        return 0

    runner = deploy_web.Runner(
        args.host,
        args.user,
        args.port,
        verbose=args.verbose,
    )
    result: dict[str, Any] | None = None
    failure: Exception | None = None
    try:
        result = run_drills(
            runner,
            user=args.user,
            base_image=args.base_image,
            drill_id=drill_id,
        )
    except (DrillError, deploy_web.DeploymentError, OSError) as exc:
        failure = exc
    finally:
        try:
            runner.ssh(cleanup_script(names), capture=False)
        except (deploy_web.DeploymentError, OSError) as cleanup_error:
            if failure is None:
                failure = cleanup_error
            else:
                print(f"WARNING: cleanup also failed: {cleanup_error}")

    if failure is not None:
        print(f"ERROR: {failure}")
        return 1
    assert result is not None
    report = write_report(drill_id, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"[done] drill report: {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
