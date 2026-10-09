#!/usr/bin/env python3
"""Run real Chromium against built assets and isolated, in-memory API fixtures.

No application backend, database, credentials, voice connection or internet
music provider is started. All fixture endpoints are read-only. This complements
unit tests rather than making a claim about production TeamSpeak connectivity.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
import json
from pathlib import Path
import socket
import sys
import threading
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
import uvicorn

if __package__:
    from . import browser_smoke
else:
    import browser_smoke


SONGS = [{
    "id": index, "queue_id": index, "track_id": index,
    "title": f"CI fixture song {index}", "artist": "Isolated fixture",
    "cover": "/fixture-cover.svg", "cover_url": "/fixture-cover.svg",
    "duration": 180, "duration_ms": 180000,
} for index in range(1, 8)]


def create_app(dist: Path) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/api/external/status")
    async def status():
        return {
            "state": "playing", "track_id": 1, "now_playing_title": SONGS[0]["title"],
            "now_playing_artist": SONGS[0]["artist"], "artwork_url": "/fixture-cover.svg",
            "duration": 180, "current_time": 0, "volume_percent": 10, "queue_preview": SONGS,
        }

    @app.get("/api/external/queue")
    async def queue():
        return {"items": SONGS}

    @app.get("/api/lyrics/{item_id}")
    async def lyrics(item_id: int):
        return {"lyrics": [{"time": 0, "text": "Isolated browser fixture", "translation": "隔离浏览器测试"}]}

    @app.get("/api/admin/qqmusic/status")
    async def cookie_status():
        return {"admin_cookie_set": False, "cookie_set": False}

    @app.get("/api/config/public")
    async def public_config():
        return {"require_api_auth": False, "require_admin_auth": False}

    @app.get("/fixture-cover.svg")
    async def cover():
        return Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#126c9e"/></svg>',
            media_type="image/svg+xml",
        )

    @app.websocket("/ws/status")
    async def websocket(websocket: WebSocket):
        await websocket.accept()
        try:
            while True:
                await websocket.send_json({"type": "progress", "state": "playing", "position": 0, "song": SONGS[0]})
                await asyncio.sleep(1)
        except (WebSocketDisconnect, RuntimeError):
            pass

    # Fail unexpected API reads explicitly instead of returning SPA HTML.
    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def unknown_api(path: str):
        raise HTTPException(status_code=404, detail="Not part of the read-only CI fixture")

    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app


@contextmanager
def fixture_server(dist: Path):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(64)
    address = f"http://127.0.0.1:{listener.getsockname()[1]}"
    server = uvicorn.Server(uvicorn.Config(create_app(dist), log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        if not server.started:
            raise RuntimeError("CI fixture server failed to start")
        yield address
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        if thread.is_alive():
            server.force_exit = True
            thread.join(timeout=2)
        listener.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[1] / "web" / "dist")
    parser.add_argument("--report", type=Path, default=Path("artifacts/ci-browser/report.json"))
    arguments = parser.parse_args(argv)
    if not (arguments.dist / "index.html").is_file():
        parser.error("Build the web application before running CI browser smoke")
    reports = []
    with fixture_server(arguments.dist.resolve()) as base_url:
        for mobile in (False, True):
            argv = ["--base-url", base_url, "--api-token", "", "--exercise-visuals", "--artifacts-dir", str(arguments.report.parent)]
            if mobile:
                argv += ["--mobile", "--viewport-width", "390", "--viewport-height", "844"]
            args = browser_smoke.build_parser().parse_args(argv)
            result = browser_smoke.run_browser_smoke(args, base_url)
            result["profile"] = "mobile" if mobile else "desktop"
            reports.append(result)
    result = {"ok": all(report["ok"] for report in reports), "isolated_readonly": True, "profiles": reports}
    arguments.report.parent.mkdir(parents=True, exist_ok=True)
    arguments.report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
