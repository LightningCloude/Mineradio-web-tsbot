#!/usr/bin/env python3
"""Paired backend/Web source release with playback checkpoint; voice is never replaced.

Defaults to read-only discovery. Uses the installed backend image as an immutable
base, retaining dependencies. Private runtime files never enter the build context.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import shlex
import tarfile
import tempfile

if __package__:
    from . import deploy_web as deploy
else:
    import deploy_web as deploy


def create_package(output):
    roots = ["Dockerfile.backend-update", "Dockerfile.web-dist", "backend", "proto", "web/dist", "docker/nginx-web.conf", "LICENSE", "LICENSES", "THIRD_PARTY_NOTICES.md"]
    def allowed(info):
        parts = Path(info.name).parts
        if info.issym() or info.islnk() or any(part in {".venv", "__pycache__", ".git", "node_modules"} for part in parts): return None
        if parts[0] == "backend" and info.isfile() and not info.name.endswith((".py", ".txt")): return None
        if parts[0] == "proto" and info.isfile() and not info.name.endswith(".proto"): return None
        info.uid = info.gid = 0; info.uname = info.gname = ""
        info.mode = 0o755 if info.isdir() else 0o644
        return info
    with tarfile.open(output, "w:gz") as archive:
        for root in roots: archive.add(deploy.REPO_ROOT / root, arcname=root, filter=allowed)
    return hashlib.sha256(output.read_bytes()).hexdigest()


def remote_script(state, release, archive, digest, backend_image, base_id, resume_release=None):
    q = shlex.quote
    directory = f"{state.releases_root}/{release}"
    override = f"{directory}/production-compose.override.yml"
    new_compose = deploy.compose_command(state, override)
    old_compose = deploy.compose_command(state, state.current_override)
    web_image = f"minerats-web:release-{release}"
    base_tag = f"minerats-backend-base:{base_id.split(':')[-1][:20]}"
    backend_container = f"{state.project}-backend-1"
    checkpoint = f"/app/data/.playback-checkpoint-{release}.json"
    backup = f"/app/data/.predeploy-{release}.db"
    update_override = """import os,sys,yaml
p,previous,backend,web,checkpoint=sys.argv[1:]
with open(previous,encoding='utf-8') as source: value=yaml.safe_load(source)
services=value.setdefault('services',{})
services.setdefault('web',{})['image']=web
b=services.setdefault('backend',{}); b['image']=backend
env=b.setdefault('environment',{})
if not isinstance(env,dict): raise RuntimeError('Expected mapping environment')
env['TSBOT_RELEASE_PLAYBACK_CHECKPOINT']=checkpoint
with open(p,'w',encoding='utf-8') as target: yaml.safe_dump(value,target,sort_keys=False)
os.chmod(p,0o600)
"""
    capture = """import asyncio,json,os,sqlite3,time,urllib.request
from pathlib import Path
checkpoint,backup=map(Path,__import__('sys').argv[1:3])
assert checkpoint.parent == backup.parent == Path('/app/data')
payload=json.load(urllib.request.urlopen('http://127.0.0.1:8009/external/status',timeout=10))
resume=__import__('sys').argv[3]
if resume and payload.get('state')=='idle' and payload.get('track_id') is None:
 old=json.load(open(resume,encoding='utf-8'))
 async def verify_voice():
  from backend.voice_client import VoiceClient
  voice=VoiceClient()
  try: return await voice.get_status()
  finally: await voice.close()
 actual=asyncio.run(verify_voice())
 assert actual.now_playing_source_url==old.get('now_playing_source_url'), 'Cannot restore checkpoint for different audio'
 assert actual.state==('STATE_PAUSED' if old['state']=='paused' else 'STATE_PLAYING'), 'Voice state no longer matches checkpoint'
 if old['state']=='playing': old['current_time']+=max(0,time.time()-old['captured_at'])
 old['queue_length']=payload['queue_length']; payload=old
payload['captured_at']=time.time()
checkpoint.write_text(json.dumps(payload),encoding='utf-8'); checkpoint.chmod(0o600)
source=sqlite3.connect('file:/app/data/tsbot.db?mode=ro',uri=True); target=sqlite3.connect(backup)
source.backup(target)
assert target.execute('PRAGMA quick_check').fetchone()[0]=='ok'
target.close(); source.close(); backup.chmod(0o600)
"""
    verify = """import json,sys,time,urllib.request
payload=json.load(open(sys.argv[1],encoding='utf-8'))
current=json.load(urllib.request.urlopen('http://127.0.0.1:8009/external/status',timeout=10))
if payload.get('state') in ('playing','paused'):
 assert current['track_id']==payload['track_id'], 'Current track metadata was not restored'
 assert current['state']==payload['state'], 'Playback state changed during release'
 expected=payload['current_time']+(time.time()-payload['captured_at'] if payload['state']=='playing' else 0)
 assert abs(current['current_time']-min(expected,payload.get('duration') or expected))<3, 'Playback position changed'
print(json.dumps({k:current.get(k) for k in ('state','track_id','current_time','queue_length')},ensure_ascii=True))
"""
    # Verification runs inside the new container; checkpoint was consumed on boot,
    # so copy a private audit snapshot to a separate tmp path for comparison.
    return f"""set -eu
umask 077
directory={q(directory)}
archive={q(archive)}
probe={q('minerats-web-probe-' + release)}
container={q(state.container)}
switched=0
complete=0
cleanup() {{
  sudo docker rm -f "$probe" >/dev/null 2>&1 || true
  if [ "$switched" = 1 ] && [ "$complete" != 1 ]; then
    echo '[rollback] restoring previous backend and Web images' >&2
    cd {q(state.working_dir)}
    {old_compose} up -d --no-deps backend web || true
  fi
}}
trap cleanup EXIT HUP INT TERM
[ ! -e "$directory" ] || {{ echo 'Release directory already exists' >&2; exit 1; }}
printf '%s  %s\\n' {q(digest)} "$archive" | sha256sum -c -
sudo install -d -m 700 -o {q(state.remote_group)} -g {q(state.remote_group)} "$directory" "$directory/build-context"
tar -xzpf "$archive" --no-same-owner -C "$directory/build-context"
cd "$directory/build-context"
sudo docker tag {q(base_id)} {q(base_tag)}
[ "$(sudo docker image inspect --format '{{{{.Id}}}}' {q(base_tag)})" = {q(base_id)} ]
sudo docker build --pull=false --build-arg {q('BASE_IMAGE=' + base_tag)} -f Dockerfile.backend-update -t {q(backend_image)} .
sudo docker build --pull=false -f Dockerfile.web-dist -t {q(web_image)} .
sudo docker run --rm --network none --entrypoint python {q(backend_image)} -m unittest backend.tests.test_clear_queue backend.tests.test_qq_library backend.tests.test_api_routes -v
sudo docker run -d --rm --name "$probe" --network {q(state.network)} -p 127.0.0.1::8080 {q(web_image)} >/dev/null
ready=0
for attempt in $(seq 1 30); do
  probe_port=$(sudo docker port "$probe" 8080/tcp 2>/dev/null | sed -n 's/.*://p' | head -n 1)
  if [ -n "$probe_port" ] && curl --noproxy '*' -fsS "http://127.0.0.1:$probe_port/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || {{ sudo docker logs "$probe" --tail 10 >&2; exit 1; }}
sudo python3 -c {q(update_override)} {q(override)} {q(state.current_override)} {q(backend_image)} {q(web_image)} {q(checkpoint)}
cd {q(state.working_dir)}
{new_compose} config -q
{f'sudo docker cp {q(state.releases_root + "/" + resume_release + "/predeploy-playback.json")} {q(backend_container + ":/tmp/release-resume.json")}' if resume_release else ':'}
sudo docker exec {q(backend_container)} python -c {q(capture)} {q(checkpoint)} {q(backup)} {q('/tmp/release-resume.json' if resume_release else '')}
sudo docker cp {q(backend_container + ':' + checkpoint)} "$directory/predeploy-playback.json"
sudo docker cp {q(backend_container + ':' + backup)} "$directory/predeploy-database.db"
sudo chmod 600 "$directory/predeploy-playback.json" "$directory/predeploy-database.db"
switched=1
{new_compose} up -d --no-deps backend
ready=0
for attempt in $(seq 1 45); do
  if sudo docker exec {q(backend_container)} python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8009/health/ready',timeout=3).close()" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || {{ echo 'Backend readiness failed' >&2; exit 1; }}
sudo docker cp "$directory/predeploy-playback.json" {q(backend_container + ':/tmp/predeploy-playback.json')}
sudo docker exec {q(backend_container)} python -c {q(verify)} /tmp/predeploy-playback.json
{new_compose} up -d --no-deps web
{deploy.web_readiness_script()}
for attempt in 1 2 3; do
  sudo docker exec "$container" wget -T 3 -qO- http://127.0.0.1:8080/api/health/ready >/dev/null
  sleep 1
done
[ "$(sudo docker inspect --format '{{{{.Config.Image}}}}' {q(state.container)})" = {q(web_image)} ]
[ "$(sudo docker inspect --format '{{{{.Config.Image}}}}' {q(backend_container)})" = {q(backend_image)} ]
voice_id=$(sudo docker ps -q --filter {q('label=com.docker.compose.project=' + state.project)} --filter label=com.docker.compose.service=voice-service)
[ "$voice_id" = {q(state.service_ids['voice-service'])} ] || {{ echo 'Voice container identity changed' >&2; exit 1; }}
complete=1
echo '[remote] paired backend/Web switch passed; voice container unchanged'
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    deploy.add_connection_arguments(parser)
    parser.add_argument('--release', type=deploy.validate_release, required=True)
    parser.add_argument('--resume-checkpoint-release', type=deploy.validate_release, help='Restore private metadata after an earlier rollback only if the same voice source/state is verified')
    args = parser.parse_args()
    if not args.host: parser.error('--host is required')
    runner = deploy.Runner(args.host, args.user, args.port)
    state = deploy.discover_remote(runner, args.container)
    q = shlex.quote
    backend_container = f"{state.project}-backend-1"
    backend = json.loads(runner.ssh(f"sudo docker inspect {q(backend_container)} --format '{{{{json .}}}}'"))
    backend_image = f"minerats-backend:release-{args.release}"
    deploy.print_state(state)
    print(f"[plan] backend + Web only; installed immutable backend base: {backend['Image']}")
    if not args.execute:
        print('Read-only preflight complete. Use --execute after local tests and browser checks.'); return 0
    directory = f"{state.releases_root}/{args.release}"
    report = {'release': args.release, 'operation': 'backend-web', 'previous': asdict(state),
        'previous_backend_image': backend['Config']['Image'], 'previous_backend_id': backend['Image'],
        'backend_image': backend_image, 'web_image': f'minerats-web:release-{args.release}',
        'rollback_override': state.current_override, 'queue_mutations': 0, 'voice_unchanged': False, 'ok': False}
    try:
        with tempfile.TemporaryDirectory(prefix='minerats-paired-release-') as folder:
            archive = Path(folder) / 'release.tar.gz'; digest = create_package(archive)
            remote_archive = f'/tmp/minerats-{args.release}.tar.gz'
            report['archive_sha256'] = digest
            runner.upload(archive, remote_archive)
            runner.ssh(remote_script(state, args.release, remote_archive, digest, backend_image, backend['Image'], args.resume_checkpoint_release), capture=False)
        try:
            # Only read-only acceptance can retry; queue/player writes never do.
            for attempt in range(2):
                try:
                    report['acceptance'] = deploy.run_acceptance(runner, args.public_url or f'http://{args.host}:8080', with_browser=not args.skip_browser)
                    break
                except deploy.DeploymentError as error:
                    report.setdefault('acceptance_retry_errors', []).append(str(error))
                    if attempt: raise
                    print('[acceptance] repeating read-only checks after a transient failure')
        except Exception:
            runner.ssh(f"set -eu; cd {q(state.working_dir)}; {deploy.compose_command(state, state.current_override)} up -d --no-deps backend web", capture=False)
            report['rolled_back'] = True
            raise
        report['voice_unchanged'] = True; report['ok'] = True
    finally:
        output = deploy.REPO_ROOT / 'artifacts' / 'releases' / args.release / 'paired-deploy-report.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[report] {output}')
    return 0


if __name__ == '__main__': raise SystemExit(main())
