#!/usr/bin/env python3
"""Read-only acceptance checks for a deployed TSBot web entry point."""

from __future__ import annotations

import argparse
import base64
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import struct
import subprocess
import sys
from dataclasses import asdict, dataclass
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, build_opener, HTTPSHandler


USER_AGENT = "TSBot-Deployment-Verifier/1.0"
WEBSOCKET_PROTOCOL = "minerats-v1"
WEBSOCKET_TOKEN_PREFIX = "minerats-token."
REQUIRED_OPENAPI_PATHS = (
    "/external/status",
    "/external/search",
    "/external/queue",
    "/visual/beat-cache",
    "/admin/status",
)


class CheckFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class HttpResult:
    url: str
    status: int
    content_type: str
    body: bytes


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str
    detail: str


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.assets: list[str] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        values = {key.lower(): value for key, value in attrs if value}
        if tag.lower() == "script" and values.get("src"):
            self.assets.append(values["src"])
            return
        if tag.lower() != "link" or not values.get("href"):
            return
        rel = {part.lower() for part in values.get("rel", "").split()}
        if "stylesheet" in rel:
            self.assets.append(values["href"])


def normalize_base_url(value: str) -> str:
    normalized = (value or "").strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must be an absolute http:// or https:// URL")
    if parsed.query or parsed.fragment:
        raise ValueError("base URL must not contain a query string or fragment")
    return normalized


def deployment_url(base_url: str, path: str) -> str:
    return f"{base_url}/{path.lstrip('/')}"


def websocket_protocols(api_token: str) -> list[str]:
    token = (api_token or "").strip()
    if not token:
        return []
    encoded = base64.urlsafe_b64encode(token.encode("utf-8")).decode("ascii")
    encoded = encoded.rstrip("=")
    return [WEBSOCKET_PROTOCOL, f"{WEBSOCKET_TOKEN_PREFIX}{encoded}"]


def make_opener(insecure: bool):
    if not insecure:
        return build_opener()
    context = ssl._create_unverified_context()
    return build_opener(HTTPSHandler(context=context))


def http_get(
    opener,
    url: str,
    timeout: float,
    headers: dict[str, str] | None = None,
) -> HttpResult:
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    request = Request(url, headers=request_headers, method="GET")
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as exc:
        response = exc
    except (URLError, TimeoutError, OSError) as exc:
        raise CheckFailure(f"request failed: {exc}") from exc

    try:
        body = response.read()
        content_type = response.headers.get_content_type()
        return HttpResult(
            url=response.geturl(),
            status=int(response.status),
            content_type=content_type,
            body=body,
        )
    finally:
        response.close()


def require_status(result: HttpResult, expected: int = 200) -> None:
    if result.status != expected:
        raise CheckFailure(f"HTTP {result.status} from {result.url}")


def parse_json(result: HttpResult) -> dict:
    require_status(result)
    try:
        payload = json.loads(result.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CheckFailure(f"invalid JSON from {result.url}") from exc
    if not isinstance(payload, dict):
        raise CheckFailure(f"expected a JSON object from {result.url}")
    return payload


def extract_local_assets(page_url: str, body: bytes) -> list[str]:
    try:
        html = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CheckFailure("web entry point is not UTF-8 HTML") from exc

    parser = AssetParser()
    parser.feed(html)
    page_origin = urlparse(page_url)
    assets: list[str] = []
    for raw in parser.assets:
        resolved = urljoin(page_url, raw)
        parsed = urlparse(resolved)
        if (parsed.scheme, parsed.netloc) != (page_origin.scheme, page_origin.netloc):
            continue
        if resolved not in assets:
            assets.append(resolved)
    return assets


def check_web_entry(opener, base_url: str, timeout: float) -> tuple[HttpResult, list[str]]:
    page = http_get(opener, deployment_url(base_url, "/"), timeout)
    require_status(page)
    if page.content_type != "text/html":
        raise CheckFailure(f"expected text/html, got {page.content_type}")
    assets = extract_local_assets(page.url, page.body)
    if not assets:
        raise CheckFailure("no same-origin script or stylesheet assets found")
    return page, assets


def check_static_assets(opener, assets: list[str], timeout: float) -> str:
    for asset in assets:
        result = http_get(opener, asset, timeout)
        require_status(result)
        if result.content_type == "text/html":
            raise CheckFailure(f"asset returned SPA HTML fallback: {asset}")
        if not result.body:
            raise CheckFailure(f"asset response is empty: {asset}")
    return f"{len(assets)} same-origin assets returned non-HTML content"


def check_openapi(opener, base_url: str, timeout: float) -> str:
    result = http_get(opener, deployment_url(base_url, "/api/openapi.json"), timeout)
    payload = parse_json(result)
    if not payload.get("openapi"):
        raise CheckFailure("response is JSON but not an OpenAPI document")
    paths = payload.get("paths")
    if not isinstance(paths, dict):
        raise CheckFailure("OpenAPI document has no paths object")
    missing = [path for path in REQUIRED_OPENAPI_PATHS if path not in paths]
    if missing:
        raise CheckFailure(f"OpenAPI is missing paths: {', '.join(missing)}")
    return f"OpenAPI {payload['openapi']} exposes required routes"


def check_external_status(
    opener,
    base_url: str,
    timeout: float,
    api_token: str,
) -> str:
    headers = {}
    if api_token.strip():
        headers["Authorization"] = f"Bearer {api_token.strip()}"
    result = http_get(
        opener,
        deployment_url(base_url, "/api/external/status"),
        timeout,
        headers,
    )
    payload = parse_json(result)
    if "queue_length" not in payload:
        raise CheckFailure("external status has no queue_length field")
    state = payload.get("state") or payload.get("status") or "unknown"
    return f"backend status is reachable (state={state}, queue={payload['queue_length']})"


def check_admin_proxy(opener, base_url: str, timeout: float) -> str:
    result = http_get(opener, deployment_url(base_url, "/admin/status"), timeout)
    payload = parse_json(result)
    if not isinstance(payload.get("admin_cookie_set"), bool):
        raise CheckFailure("admin status response has an invalid admin_cookie_set field")
    return "admin proxy preserves the /admin path"


def check_cover_proxy(
    opener,
    base_url: str,
    timeout: float,
    page_body: bytes,
) -> str:
    result = http_get(
        opener,
        deployment_url(base_url, "/cover/__tsbot_acceptance_probe__.jpg"),
        timeout,
    )
    if result.status >= 500:
        raise CheckFailure(f"cover proxy returned HTTP {result.status}")
    if result.status == 200 and result.content_type == "text/html":
        raise CheckFailure("cover request returned SPA HTML instead of proxy content")
    if result.body and hashlib.sha256(result.body).digest() == hashlib.sha256(page_body).digest():
        raise CheckFailure("cover request returned the web entry point")
    return f"cover path bypasses the SPA fallback (HTTP {result.status})"


class BufferedSocket:
    def __init__(self, sock: socket.socket, initial: bytes = b"") -> None:
        self.sock = sock
        self.buffer = bytearray(initial)

    def read_exact(self, size: int) -> bytes:
        while len(self.buffer) < size:
            chunk = self.sock.recv(max(4096, size - len(self.buffer)))
            if not chunk:
                raise CheckFailure("WebSocket closed unexpectedly")
            self.buffer.extend(chunk)
        data = bytes(self.buffer[:size])
        del self.buffer[:size]
        return data


def websocket_request(base_url: str, api_token: str) -> tuple[str, int, bytes, str]:
    parsed = urlparse(base_url)
    secure = parsed.scheme == "https"
    port = parsed.port or (443 if secure else 80)
    host = parsed.hostname or ""
    path = f"{parsed.path.rstrip('/')}/ws/status" or "/ws/status"
    host_header = host
    if ":" in host and not host.startswith("["):
        host_header = f"[{host}]"
    if port != (443 if secure else 80):
        host_header = f"{host_header}:{port}"

    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    headers = [
        f"GET {path} HTTP/1.1",
        f"Host: {host_header}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
        f"User-Agent: {USER_AGENT}",
    ]
    protocols = websocket_protocols(api_token)
    if protocols:
        headers.append(f"Sec-WebSocket-Protocol: {', '.join(protocols)}")
    request = ("\r\n".join(headers) + "\r\n\r\n").encode("ascii")
    return host, port, request, key


def read_http_headers(sock: socket.socket) -> tuple[str, dict[str, str], bytes]:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise CheckFailure("connection closed during WebSocket handshake")
        data.extend(chunk)
        if len(data) > 65536:
            raise CheckFailure("WebSocket handshake headers are too large")
    raw_headers, remainder = bytes(data).split(b"\r\n\r\n", 1)
    lines = raw_headers.decode("iso-8859-1").split("\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    return lines[0], headers, remainder


def send_text_frame(sock: socket.socket, text: str) -> None:
    payload = text.encode("utf-8")
    mask = secrets.token_bytes(4)
    if len(payload) <= 125:
        header = bytes((0x81, 0x80 | len(payload)))
    elif len(payload) <= 65535:
        header = bytes((0x81, 0x80 | 126)) + struct.pack("!H", len(payload))
    else:
        header = bytes((0x81, 0x80 | 127)) + struct.pack("!Q", len(payload))
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    sock.sendall(header + mask + masked)


def read_frame(stream: BufferedSocket) -> tuple[int, bytes]:
    first, second = stream.read_exact(2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", stream.read_exact(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", stream.read_exact(8))[0]
    mask = stream.read_exact(4) if masked else b""
    payload = stream.read_exact(length)
    if mask:
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return opcode, payload


def check_websocket(
    base_url: str,
    timeout: float,
    api_token: str,
    insecure: bool,
) -> str:
    parsed = urlparse(base_url)
    host, port, request, key = websocket_request(base_url, api_token)
    try:
        raw_sock = socket.create_connection((host, port), timeout=timeout)
        if parsed.scheme == "https":
            context = ssl._create_unverified_context() if insecure else ssl.create_default_context()
            sock = context.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock
        sock.settimeout(timeout)
    except (OSError, ssl.SSLError) as exc:
        raise CheckFailure(f"WebSocket connection failed: {exc}") from exc

    try:
        sock.sendall(request)
        status_line, headers, remainder = read_http_headers(sock)
        if " 101 " not in f" {status_line} ":
            hint = " (set --api-token if protection is enabled)" if not api_token else ""
            raise CheckFailure(f"handshake returned {status_line}{hint}")

        expected_accept = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected_accept:
            raise CheckFailure("invalid Sec-WebSocket-Accept header")
        if api_token and headers.get("sec-websocket-protocol") != WEBSOCKET_PROTOCOL:
            raise CheckFailure("server did not select the minerats-v1 subprotocol")

        send_text_frame(sock, "ping")
        stream = BufferedSocket(sock, remainder)
        for _ in range(8):
            opcode, payload = read_frame(stream)
            if opcode == 0x8:
                raise CheckFailure("WebSocket closed before pong")
            if opcode != 0x1:
                continue
            try:
                message = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if message == {"type": "pong"}:
                return "WebSocket handshake and ping/pong succeeded"
        raise CheckFailure("WebSocket connected but did not return pong")
    except (OSError, TimeoutError) as exc:
        raise CheckFailure(f"WebSocket I/O failed: {exc}") from exc
    finally:
        sock.close()


def browser_smoke_invocation(
    base_url: str,
    timeout: float,
    api_token: str,
    insecure: bool,
    browser_engine: str,
) -> tuple[list[str], dict[str, str]]:
    script = Path(__file__).resolve().with_name("browser_smoke.py")
    command = [
        sys.executable,
        str(script),
        "--base-url",
        base_url,
        "--timeout",
        str(max(timeout, 15.0)),
        "--browser",
        browser_engine,
        "--json",
    ]
    if insecure:
        command.append("--insecure")
    environment = os.environ.copy()
    if api_token.strip():
        environment["TSBOT_API_TOKEN"] = api_token.strip()
    return command, environment


def check_browser_smoke(
    base_url: str,
    timeout: float,
    api_token: str,
    insecure: bool,
    browser_engine: str,
) -> str:
    command, environment = browser_smoke_invocation(
        base_url,
        timeout,
        api_token,
        insecure,
        browser_engine,
    )
    try:
        completed = subprocess.run(
            command,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=max(timeout * 10, 60),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CheckFailure(f"browser smoke could not run: {exc}") from exc

    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        error = (completed.stderr or completed.stdout or "no output").strip()
        raise CheckFailure(f"browser smoke returned invalid output: {error[:500]}") from exc

    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        raise CheckFailure("browser smoke report has no results list")
    failed = [item for item in results if item.get("status") == "fail"]
    if completed.returncode != 0 or failed or not payload.get("ok"):
        detail = "; ".join(
            f"{item.get('name')}: {item.get('detail')}" for item in failed[:3]
        )
        artifact = payload.get("artifact_dir")
        if artifact:
            detail = f"{detail}; artifacts={artifact}"
        raise CheckFailure(detail or f"browser smoke exited {completed.returncode}")
    passed = sum(item.get("status") == "pass" for item in results)
    return f"{browser_engine} browser smoke passed ({passed}/{len(results)})"


class Reporter:
    def __init__(self) -> None:
        self.results: list[CheckResult] = []

    def pass_(self, name: str, detail: str) -> None:
        self.results.append(CheckResult(name, "pass", detail))

    def fail(self, name: str, detail: str) -> None:
        self.results.append(CheckResult(name, "fail", detail))

    def skip(self, name: str, detail: str) -> None:
        self.results.append(CheckResult(name, "skip", detail))

    def run(self, name: str, check: Callable[[], str]) -> None:
        try:
            self.pass_(name, check())
        except (CheckFailure, ValueError) as exc:
            self.fail(name, str(exc))
        except Exception as exc:  # Keep independent checks running.
            self.fail(name, f"unexpected {type(exc).__name__}: {exc}")

    @property
    def failed(self) -> int:
        return sum(result.status == "fail" for result in self.results)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run read-only acceptance checks against a TSBot web URL.",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("TSBOT_VERIFY_BASE_URL", "http://127.0.0.1:8080"),
        help="public Web base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--api-token",
        default=os.getenv("TSBOT_API_TOKEN", ""),
        help="API token; defaults to TSBOT_API_TOKEN without printing it",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=8.0,
        help="timeout per network operation in seconds (default: %(default)s)",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="disable TLS certificate validation for private test environments",
    )
    parser.add_argument("--skip-cover", action="store_true")
    parser.add_argument("--skip-websocket", action="store_true")
    parser.add_argument(
        "--with-browser",
        action="store_true",
        help="also run the read-only Playwright browser smoke suite",
    )
    parser.add_argument(
        "--browser-engine",
        choices=("chromium", "firefox", "webkit"),
        default="chromium",
    )
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        base_url = normalize_base_url(args.base_url)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.timeout <= 0:
        print("error: --timeout must be greater than zero", file=sys.stderr)
        return 2

    opener = make_opener(args.insecure)
    reporter = Reporter()
    page: HttpResult | None = None
    assets: list[str] = []

    try:
        page, assets = check_web_entry(opener, base_url, args.timeout)
        reporter.pass_("web-entry", f"{page.content_type}, {len(page.body)} bytes")
    except CheckFailure as exc:
        reporter.fail("web-entry", str(exc))

    if assets:
        reporter.run(
            "static-assets",
            lambda: check_static_assets(opener, assets, args.timeout),
        )
    else:
        reporter.skip("static-assets", "web entry check did not discover assets")

    reporter.run(
        "openapi-proxy",
        lambda: check_openapi(opener, base_url, args.timeout),
    )
    reporter.run(
        "backend-status",
        lambda: check_external_status(
            opener,
            base_url,
            args.timeout,
            args.api_token,
        ),
    )
    reporter.run(
        "admin-proxy",
        lambda: check_admin_proxy(opener, base_url, args.timeout),
    )

    if args.skip_cover:
        reporter.skip("cover-proxy", "disabled by --skip-cover")
    elif page is None:
        reporter.skip("cover-proxy", "web entry body unavailable for fallback comparison")
    else:
        reporter.run(
            "cover-proxy",
            lambda: check_cover_proxy(opener, base_url, args.timeout, page.body),
        )

    if args.skip_websocket:
        reporter.skip("websocket", "disabled by --skip-websocket")
    else:
        reporter.run(
            "websocket",
            lambda: check_websocket(
                base_url,
                args.timeout,
                args.api_token,
                args.insecure,
            ),
        )

    if args.with_browser:
        reporter.run(
            "browser-smoke",
            lambda: check_browser_smoke(
                base_url,
                args.timeout,
                args.api_token,
                args.insecure,
                args.browser_engine,
            ),
        )
    else:
        reporter.skip("browser-smoke", "enable with --with-browser")

    if args.json_output:
        print(
            json.dumps(
                {
                    "base_url": base_url,
                    "ok": reporter.failed == 0,
                    "results": [asdict(result) for result in reporter.results],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(f"TSBot deployment acceptance: {base_url}")
        for result in reporter.results:
            marker = {"pass": "PASS", "fail": "FAIL", "skip": "SKIP"}[result.status]
            print(f"[{marker}] {result.name}: {result.detail}")
        passed = sum(result.status == "pass" for result in reporter.results)
        skipped = sum(result.status == "skip" for result in reporter.results)
        print(
            f"Summary: {passed} passed, {reporter.failed} failed, {skipped} skipped"
        )

    return 1 if reporter.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
