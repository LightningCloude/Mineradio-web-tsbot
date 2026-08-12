#!/usr/bin/env python3
"""Playwright smoke tests for the TSBot web UI.

The default mode is read-only with respect to the server. Browser-local data is
written only inside a fresh, temporary browser context.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable
from urllib.parse import urlparse


REMOTE_CONFIRMATION = "I_UNDERSTAND_THIS_CHANGES_THE_REMOTE_QUEUE"
ISOLATED_PLAYBACK_CONFIRMATION = "THIS_IS_AN_ISOLATED_PLAYBACK_TARGET"
CRITICAL_RESOURCE_TYPES = {"document", "script", "stylesheet", "xhr", "fetch"}


class SmokeFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class SmokeResult:
    name: str
    status: str
    detail: str


def normalize_base_url(value: str) -> str:
    normalized = (value or "").strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must be an absolute http:// or https:// URL")
    if parsed.query or parsed.fragment:
        raise ValueError("base URL must not contain a query string or fragment")
    return normalized


def is_loopback_host(hostname: str | None) -> bool:
    return (hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}


def validate_mutation_policy(args: argparse.Namespace, base_url: str) -> None:
    if args.mode == "readonly":
        if args.exercise_playback:
            raise ValueError("--exercise-playback requires --mode stateful")
        return

    if not args.allow_state_changes:
        raise ValueError("stateful mode requires --allow-state-changes")
    hostname = urlparse(base_url).hostname
    if not is_loopback_host(hostname) and args.remote_confirmation != REMOTE_CONFIRMATION:
        raise ValueError(
            "remote stateful mode requires "
            f"--remote-confirmation {REMOTE_CONFIRMATION}"
        )
    if not (args.search_query or "").strip():
        raise ValueError("stateful mode requires a non-empty --search-query")
    if args.exercise_playback:
        if not is_loopback_host(hostname):
            raise ValueError("playback exercise is restricted to loopback targets")
        if args.isolated_playback_confirmation != ISOLATED_PLAYBACK_CONFIRMATION:
            raise ValueError(
                "playback exercise requires "
                f"--isolated-playback-confirmation {ISOLATED_PLAYBACK_CONFIRMATION}"
            )


def critical_request_failure(resource_type: str) -> bool:
    return resource_type in CRITICAL_RESOURCE_TYPES


def benign_request_failure(failure: str) -> bool:
    return (failure or "").strip() == "net::ERR_ABORTED"


def benign_console_error(message: str) -> bool:
    text = (message or "").strip()
    if text.startswith("Failed to load resource:"):
        return True
    return text.startswith("Access to image at ") and "CORS policy" in text


def is_direct_qq_cover_request(url: str) -> bool:
    parsed = urlparse(url)
    return (
        (parsed.hostname or "").lower() == "y.gtimg.cn"
        and parsed.path.startswith("/music/photo_new/")
    )


def valid_cover_proxy_response(status: int, content_type: str) -> bool:
    return status < 400 and not (content_type or "").lower().startswith("text/html")


def api_token_init_script(api_token: str) -> str:
    encoded = json.dumps((api_token or "").strip(), ensure_ascii=False)
    return f"localStorage.setItem('tsbot_api_token', {encoded});"


def artifact_directory(root: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    return root / stamp


class SmokeReporter:
    def __init__(self) -> None:
        self.results: list[SmokeResult] = []

    def run(self, name: str, check: Callable[[], str]) -> None:
        try:
            self.results.append(SmokeResult(name, "pass", check()))
        except Exception as exc:
            self.results.append(
                SmokeResult(name, "fail", f"{type(exc).__name__}: {exc}")
            )

    @property
    def failed(self) -> int:
        return sum(item.status == "fail" for item in self.results)


def expect_visible(page, selector: str, timeout_ms: int) -> None:
    locator = page.locator(selector)
    locator.wait_for(state="visible", timeout=timeout_ms)


def check_app_shell(page, timeout_ms: int) -> str:
    expect_visible(page, ".player-bar", timeout_ms)
    expect_visible(page, "#particle-canvas", timeout_ms)
    canvas = page.locator("#particle-canvas")
    box = canvas.bounding_box()
    if not box or box["width"] < 100 or box["height"] < 100:
        raise SmokeFailure("particle canvas has no usable rendered area")
    controls = page.locator('.player-bar [data-action]')
    if controls.count() < 8:
        raise SmokeFailure(f"expected player controls, found {controls.count()}")
    return f"player and WebGL canvas initialized ({int(box['width'])}x{int(box['height'])})"


def open_and_close(page, button: str, panel: str, timeout_ms: int) -> str:
    page.locator(button).click()
    expect_visible(page, panel, timeout_ms)
    page.keyboard.press("Escape")
    if panel == "#queue-panel":
        page.wait_for_function(
            "() => !document.querySelector('#queue-panel')?.classList.contains('show')",
            timeout=timeout_ms,
        )
    else:
        page.locator(panel).wait_for(state="hidden", timeout=timeout_ms)
    return f"{panel} opens and closes"


def check_safe_panels(page, timeout_ms: int) -> str:
    checks = (
        ('[data-action="search"]', "#search-overlay .search-panel"),
        ('[data-action="queue"]', "#queue-panel"),
        ('[data-action="vis-settings"]', "#visual-settings-panel .vis-settings-panel"),
    )
    for button, panel in checks:
        open_and_close(page, button, panel, timeout_ms)
    return "search, playlist, and visual settings panels are interactive"


def seed_ephemeral_wallpaper(page) -> None:
    page.evaluate(
        """
        async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('minerats-bg-db', 1);
            request.onupgradeneeded = () => {
              if (!request.result.objectStoreNames.contains('videos')) {
                request.result.createObjectStore('videos');
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = db.transaction('videos', 'readwrite');
          transaction.objectStore('videos').put({
            blob: new Blob(['browser-smoke-wallpaper'], { type: 'video/webm' }),
            name: 'browser-smoke-wallpaper.webm',
            updatedAt: Date.now(),
          }, 'bg-video');
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
          db.close();
          localStorage.setItem('minerats-bg-video-on', '0');
        }
        """
    )


def check_ephemeral_wallpaper(page, base_url: str, timeout_ms: int) -> str:
    seed_ephemeral_wallpaper(page)
    page.reload(wait_until="domcontentloaded", timeout=timeout_ms)
    expect_visible(page, ".player-bar", timeout_ms)
    page.locator('[data-action="vis-settings"]').click()
    expect_visible(page, "#visual-settings-panel .vis-settings-panel", timeout_ms)

    name = page.locator("#bg-video-name")
    name.wait_for(state="visible", timeout=timeout_ms)
    page.wait_for_function(
        "() => document.querySelector('#bg-video-name')?.textContent"
        ".includes('browser-smoke-wallpaper.webm')",
        timeout=timeout_ms,
    )
    if page.locator("#bg-video-toggle").is_disabled():
        raise SmokeFailure("restored wallpaper toggle is disabled")
    if page.locator("#bg-video-remove").is_disabled():
        raise SmokeFailure("restored wallpaper remove button is disabled")

    page.locator("#bg-video-remove").click()
    page.wait_for_function(
        "() => document.querySelector('#bg-video-name')?.textContent"
        ".includes('未选择本地视频')",
        timeout=timeout_ms,
    )
    page.keyboard.press("Escape")
    return "ephemeral wallpaper survives reload and can be removed"


def fetch_queue(page) -> list[dict[str, Any]]:
    payload = page.evaluate(
        """
        async () => {
          const token = localStorage.getItem('tsbot_api_token');
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          const response = await fetch('/api/external/queue', { headers });
          if (!response.ok) throw new Error(`queue GET failed: ${response.status}`);
          return response.json();
        }
        """
    )
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        raise SmokeFailure("queue response has an unsupported shape")
    value = payload.get("items", payload.get("queue", []))
    if not isinstance(value, list):
        raise SmokeFailure("queue response does not contain a list")
    return value


def queue_ids(items: list[dict[str, Any]]) -> set[str]:
    return {
        str(item["id"])
        for item in items
        if isinstance(item, dict) and item.get("id") is not None
    }


def delete_queue_items(page, item_ids: set[str]) -> None:
    if not item_ids:
        return
    page.evaluate(
        """
        async (ids) => {
          const token = localStorage.getItem('tsbot_api_token');
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          for (const id of ids) {
            const response = await fetch(
              `/api/external/queue/${encodeURIComponent(id)}`,
              { method: 'DELETE', headers },
            );
            if (!response.ok) {
              throw new Error(`queue cleanup failed for ${id}: ${response.status}`);
            }
          }
        }
        """,
        sorted(item_ids),
    )


def search_first_result(page, query: str, timeout_ms: int):
    page.locator('[data-action="search"]').click()
    expect_visible(page, "#search-overlay .search-panel", timeout_ms)
    response = page.expect_response(
        lambda value: "/api/external/search?" in value.url,
        timeout=timeout_ms,
    )
    with response:
        page.locator(".search-input").fill(query)
    if response.value.status >= 400:
        raise SmokeFailure(f"search returned HTTP {response.value.status}")
    result = page.locator(".search-result-item").first
    result.wait_for(state="visible", timeout=timeout_ms)
    return result


def check_stateful_queue(page, query: str, timeout_ms: int) -> str:
    before = queue_ids(fetch_queue(page))
    added: set[str] = set()
    try:
        result = search_first_result(page, query, timeout_ms)
        with page.expect_response(
            lambda value: (
                "/api/external/queue" in value.url
                and value.request.method == "POST"
            ),
            timeout=timeout_ms,
        ) as response:
            result.locator(".sri-add").click()
        if response.value.status >= 400:
            raise SmokeFailure(f"enqueue returned HTTP {response.value.status}")
        page.wait_for_timeout(500)
        after = queue_ids(fetch_queue(page))
        added = after - before
        if not added:
            raise SmokeFailure("enqueue succeeded but no new queue item was found")
        delete_queue_items(page, added)
        added.clear()
        return "search and enqueue succeeded; added item was removed"
    finally:
        if not added:
            current = queue_ids(fetch_queue(page))
            added = current - before
        delete_queue_items(page, added)


def check_isolated_playback(page, query: str, timeout_ms: int) -> str:
    before = queue_ids(fetch_queue(page))
    added: set[str] = set()
    try:
        result = search_first_result(page, query, timeout_ms)
        with page.expect_response(
            lambda value: (
                "/api/external/queue" in value.url
                and value.request.method == "POST"
            ),
            timeout=timeout_ms,
        ) as response:
            result.locator(".sri-play").click()
        if response.value.status >= 400:
            raise SmokeFailure(f"play-now enqueue returned HTTP {response.value.status}")
        page.wait_for_timeout(750)
        added = queue_ids(fetch_queue(page)) - before
        if not added:
            raise SmokeFailure("play-now did not create a queue item")
        state = page.evaluate(
            """
            async () => {
              const token = localStorage.getItem('tsbot_api_token');
              const headers = {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              };
              const status = await fetch('/api/external/status', { headers });
              if (!status.ok) throw new Error(`status failed: ${status.status}`);
              const payload = await status.json();
              const pause = await fetch('/api/external/player/action', {
                method: 'POST',
                headers,
                body: JSON.stringify({ action: 'pause' }),
              });
              if (!pause.ok) throw new Error(`pause failed: ${pause.status}`);
              return payload.state || payload.status || 'unknown';
            }
            """
        )
        delete_queue_items(page, added)
        added.clear()
        return f"isolated play-now responded (state={state}); playback paused and item removed"
    finally:
        if not added:
            current = queue_ids(fetch_queue(page))
            added = current - before
        delete_queue_items(page, added)


def write_failure_artifacts(
    page,
    root: Path,
    results: list[SmokeResult],
    console_lines: list[str],
    network_lines: list[str],
) -> Path:
    target = artifact_directory(root)
    target.mkdir(parents=True, exist_ok=False)
    try:
        page.screenshot(path=str(target / "failure.png"), full_page=True)
    except Exception as exc:
        console_lines.append(f"[artifact] screenshot failed: {exc}")
    (target / "browser.log").write_text(
        "\n".join(console_lines) + "\n",
        encoding="utf-8",
    )
    (target / "network.log").write_text(
        "\n".join(network_lines) + "\n",
        encoding="utf-8",
    )
    (target / "result.json").write_text(
        json.dumps(
            {"ok": False, "results": [asdict(item) for item in results]},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return target


def run_browser_smoke(args: argparse.Namespace, base_url: str) -> dict[str, Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SmokeFailure(
            "Playwright is not installed; install backend requirements first"
        ) from exc

    timeout_ms = int(args.timeout * 1000)
    reporter = SmokeReporter()
    console_lines: list[str] = []
    console_errors: list[str] = []
    network_lines: list[str] = []
    network_errors: list[str] = []
    direct_cover_urls: set[str] = set()
    cover_proxy_responses: list[tuple[int, str]] = []
    websocket_urls: set[str] = set()
    websocket_frames = 0
    artifact_path: Path | None = None

    with sync_playwright() as playwright:
        browser_type = getattr(playwright, args.browser)
        try:
            browser = browser_type.launch(headless=not args.headed)
        except Exception as exc:
            raise SmokeFailure(
                "browser launch failed; run "
                "`python -m playwright install chromium` for the active environment"
            ) from exc
        context = browser.new_context(
            ignore_https_errors=args.insecure,
            viewport={"width": 1440, "height": 900},
        )
        if args.api_token.strip():
            context.add_init_script(api_token_init_script(args.api_token))
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        def on_console(message) -> None:
            line = f"[{message.type}] {message.text}"
            console_lines.append(line)
            if message.type == "error" and not benign_console_error(message.text):
                console_errors.append(line)

        def on_page_error(error) -> None:
            line = f"[pageerror] {error}"
            console_lines.append(line)
            console_errors.append(line)

        def on_request_failed(request) -> None:
            failure = request.failure or "unknown failure"
            line = f"[failed] {request.method} {request.url} ({failure})"
            network_lines.append(line)
            if (
                critical_request_failure(request.resource_type)
                and not benign_request_failure(failure)
            ):
                network_errors.append(line)

        def on_request(request) -> None:
            if is_direct_qq_cover_request(request.url):
                direct_cover_urls.add(request.url)

        def on_response(response) -> None:
            request = response.request
            response_url = urlparse(response.url)
            if response_url.path.startswith("/cover/"):
                cover_proxy_responses.append(
                    (response.status, response.headers.get("content-type", ""))
                )
            if response.status < 400:
                return
            line = f"[http-{response.status}] {request.method} {response.url}"
            network_lines.append(line)
            if critical_request_failure(request.resource_type):
                network_errors.append(line)

        def on_websocket(websocket) -> None:
            nonlocal websocket_frames
            websocket_urls.add(websocket.url)
            websocket.on("framereceived", lambda _: increment_websocket_frame())

        def increment_websocket_frame() -> None:
            nonlocal websocket_frames
            websocket_frames += 1

        page.on("console", on_console)
        page.on("pageerror", on_page_error)
        page.on("request", on_request)
        page.on("requestfailed", on_request_failed)
        page.on("response", on_response)
        page.on("websocket", on_websocket)

        reporter.run(
            "page-load",
            lambda: _navigate(page, base_url, timeout_ms),
        )
        reporter.run("app-shell", lambda: check_app_shell(page, timeout_ms))
        reporter.run("safe-panels", lambda: check_safe_panels(page, timeout_ms))
        reporter.run(
            "local-wallpaper",
            lambda: check_ephemeral_wallpaper(page, base_url, timeout_ms),
        )

        page.wait_for_timeout(min(timeout_ms, 2500))

        def websocket_check() -> str:
            matching = [url for url in websocket_urls if urlparse(url).path.endswith("/ws/status")]
            if not matching:
                raise SmokeFailure("the page did not open /ws/status")
            if websocket_frames < 1:
                raise SmokeFailure("WebSocket opened but no frame was received")
            return f"/ws/status opened and received {websocket_frames} frame(s)"

        reporter.run("websocket", websocket_check)

        def cover_routing_check() -> str:
            if direct_cover_urls:
                raise SmokeFailure(
                    "QQ covers bypassed /cover proxy: "
                    + ", ".join(sorted(direct_cover_urls)[:3])
                )
            invalid = [
                (status, content_type)
                for status, content_type in cover_proxy_responses
                if not valid_cover_proxy_response(status, content_type)
            ]
            if invalid:
                raise SmokeFailure(
                    "invalid /cover response(s): "
                    + ", ".join(
                        f"HTTP {status} {content_type or 'unknown-content-type'}"
                        for status, content_type in invalid[:3]
                    )
                )
            if cover_proxy_responses:
                return (
                    f"{len(cover_proxy_responses)} QQ cover request(s) used "
                    "the same-origin proxy"
                )
            return "no QQ cover was requested and no direct CDN bypass was observed"

        reporter.run("cover-routing", cover_routing_check)

        if args.mode == "stateful":
            reporter.run(
                "search-enqueue-cleanup",
                lambda: check_stateful_queue(page, args.search_query, timeout_ms),
            )
            if args.exercise_playback:
                reporter.run(
                    "isolated-playback",
                    lambda: check_isolated_playback(
                        page,
                        args.search_query,
                        timeout_ms,
                    ),
                )

        def console_check() -> str:
            if console_errors:
                raise SmokeFailure("; ".join(console_errors[:5]))
            return f"no console/page errors ({len(console_lines)} messages observed)"

        def network_check() -> str:
            if network_errors:
                raise SmokeFailure("; ".join(network_errors[:5]))
            return f"no critical request failures ({len(network_lines)} non-2xx/failures observed)"

        reporter.run("browser-console", console_check)
        reporter.run("critical-network", network_check)

        if reporter.failed:
            artifact_path = write_failure_artifacts(
                page,
                Path(args.artifacts_dir),
                reporter.results,
                console_lines,
                network_lines,
            )

        context.close()
        browser.close()

    return {
        "base_url": base_url,
        "mode": args.mode,
        "browser": args.browser,
        "ok": reporter.failed == 0,
        "artifact_dir": str(artifact_path) if artifact_path else None,
        "results": [asdict(item) for item in reporter.results],
    }


def _navigate(page, base_url: str, timeout_ms: int) -> str:
    response = page.goto(base_url, wait_until="domcontentloaded", timeout=timeout_ms)
    if response is None:
        raise SmokeFailure("navigation returned no response")
    if response.status >= 400:
        raise SmokeFailure(f"navigation returned HTTP {response.status}")
    page.wait_for_function(
        "() => document.querySelector('.player-bar')"
        " && document.querySelector('#particle-canvas')",
        timeout=timeout_ms,
    )
    return f"HTTP {response.status}, title={page.title()!r}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run Playwright smoke tests against the TSBot web UI.",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("TSBOT_VERIFY_BASE_URL", "http://127.0.0.1:8080"),
    )
    parser.add_argument(
        "--api-token",
        default=os.getenv("TSBOT_API_TOKEN", ""),
        help="defaults to TSBOT_API_TOKEN and is never printed",
    )
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument(
        "--browser",
        choices=("chromium", "firefox", "webkit"),
        default="chromium",
    )
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument(
        "--artifacts-dir",
        default=str(Path("artifacts") / "browser-smoke"),
    )
    parser.add_argument(
        "--mode",
        choices=("readonly", "stateful"),
        default="readonly",
    )
    parser.add_argument("--search-query", default="周杰伦")
    parser.add_argument("--allow-state-changes", action="store_true")
    parser.add_argument("--remote-confirmation", default="")
    parser.add_argument("--exercise-playback", action="store_true")
    parser.add_argument("--isolated-playback-confirmation", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        base_url = normalize_base_url(args.base_url)
        if args.timeout <= 0:
            raise ValueError("--timeout must be greater than zero")
        validate_mutation_policy(args, base_url)
        report = run_browser_smoke(args, base_url)
    except (ValueError, SmokeFailure) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"TSBot browser smoke: {base_url} ({args.mode}, {args.browser})")
        for result in report["results"]:
            marker = "PASS" if result["status"] == "pass" else "FAIL"
            print(f"[{marker}] {result['name']}: {result['detail']}")
        passed = sum(item["status"] == "pass" for item in report["results"])
        failed = sum(item["status"] == "fail" for item in report["results"])
        print(f"Summary: {passed} passed, {failed} failed")
        if report["artifact_dir"]:
            print(f"Failure artifacts: {report['artifact_dir']}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
