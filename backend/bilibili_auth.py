from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from typing import Any
from urllib.parse import parse_qsl, urlparse

import httpx

from .logger import logger

try:
    import qrcode
except Exception:  # pragma: no cover - optional dependency guard
    qrcode = None

try:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright
except Exception:  # pragma: no cover - optional dependency guard
    PlaywrightTimeoutError = RuntimeError  # type: ignore[assignment]
    async_playwright = None


_BILIBILI_LOGIN_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "accept": "application/json, text/plain, */*",
    "referer": "https://passport.bilibili.com/login",
}
_BILIBILI_LOCALE_JSON = json.dumps(
    {"c_locale": {"language": "zh", "region": "CN"}, "always_translate": True},
    ensure_ascii=False,
    separators=(",", ":"),
)
_BILIBILI_QR_SESSION_TTL_S = 300.0
_BILIBILI_PLAYWRIGHT_TIMEOUT_MS = 20000
_BILIBILI_SUBTITLE_RESOURCE_RE = re.compile(r"(aisubtitle\.hdslb\.com|subtitle|caption)", re.IGNORECASE)
_PLAYWRIGHT_RUNTIME_CHECK_TIMEOUT_S = 8.0
_PLAYWRIGHT_RUNTIME_CACHE_TTL_S = 60.0
_BILIBILI_QR_FINALIZE_TIMEOUT_S = 8.0


@dataclass
class _BilibiliQrSession:
    session_id: str
    client: httpx.AsyncClient
    qrcode_key: str
    qr_url: str
    created_at: float = field(default_factory=time.time)
    authorized_cookie: str = ""
    closed: bool = False


_qr_sessions: dict[str, _BilibiliQrSession] = {}
_qr_sessions_lock = asyncio.Lock()
_playwright_runtime_cache: tuple[float, bool] | None = None
_playwright_runtime_lock = asyncio.Lock()


def is_playwright_available() -> bool:
    return async_playwright is not None


def is_qrcode_available() -> bool:
    return qrcode is not None


def _ensure_qrcode_available() -> None:
    if qrcode is None:
        raise RuntimeError("qrcode dependency is missing; run: pip install -r backend/requirements.txt")


def _ensure_playwright_available() -> None:
    if async_playwright is None:
        raise RuntimeError(
            "playwright dependency is missing; run: pip install -r backend/requirements.txt "
            "and then: python -m playwright install chromium"
        )


def _get_playwright_launch_kwargs() -> dict[str, Any]:
    args = ["--disable-dev-shm-usage"]
    try:
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            # Chromium needs sandbox flags when launched as root inside Docker.
            args.extend(["--no-sandbox", "--disable-setuid-sandbox"])
    except Exception:
        pass
    return {"headless": True, "args": args}


async def _probe_playwright_runtime_available() -> bool:
    if async_playwright is None:
        return False

    playwright = None
    browser = None
    try:
        playwright = await async_playwright().start()
        browser = await asyncio.wait_for(
            playwright.chromium.launch(**_get_playwright_launch_kwargs()),
            timeout=_PLAYWRIGHT_RUNTIME_CHECK_TIMEOUT_S,
        )
        return True
    except Exception as exc:
        logger.warning("playwright runtime probe failed: %s", exc)
        return False
    finally:
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:
                pass


async def is_playwright_runtime_available() -> bool:
    global _playwright_runtime_cache

    cached = _playwright_runtime_cache
    now = time.time()
    if cached is not None and cached[0] > now:
        return cached[1]

    async with _playwright_runtime_lock:
        cached = _playwright_runtime_cache
        now = time.time()
        if cached is not None and cached[0] > now:
            return cached[1]

        ready = await _probe_playwright_runtime_available()
        _playwright_runtime_cache = (time.time() + _PLAYWRIGHT_RUNTIME_CACHE_TTL_S, ready)
        return ready


def cookie_string_to_dict(cookie: str) -> dict[str, str]:
    raw = str(cookie or "").strip()
    if not raw:
        return {}

    jar = SimpleCookie()
    try:
        jar.load(raw)
    except Exception:
        return {}

    result: dict[str, str] = {}
    for key, morsel in jar.items():
        value = morsel.value
        if value:
            result[str(key)] = str(value)
    return result


def cookie_dict_to_header(cookie_map: dict[str, str]) -> str:
    parts = [f"{key}={value}" for key, value in cookie_map.items() if key and value]
    return "; ".join(parts)


def _cookie_header_from_client(client: httpx.AsyncClient) -> str:
    cookie_map: dict[str, str] = {}
    for item in client.cookies.jar:
        if item.name and item.value:
            cookie_map[item.name] = item.value
    return cookie_dict_to_header(cookie_map)


def _cookie_header_from_response(response: httpx.Response) -> str:
    cookie_map: dict[str, str] = {}
    for item in response.cookies.jar:
        if item.name and item.value:
            cookie_map[item.name] = item.value
    return cookie_dict_to_header(cookie_map)


def _cookie_header_from_auth_url(auth_url: str) -> str:
    raw = str(auth_url or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        query_pairs = parse_qsl(parsed.query, keep_blank_values=False)
    except Exception:
        return ""

    allowed = {"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"}
    cookie_map: dict[str, str] = {}
    for key, value in query_pairs:
        if key in allowed and value:
            cookie_map[key] = value
    return cookie_dict_to_header(cookie_map)


def _merge_cookie_headers(*cookies: str) -> str:
    cookie_map: dict[str, str] = {}
    for cookie in cookies:
        for key, value in cookie_string_to_dict(cookie).items():
            if key and value:
                cookie_map[key] = value
    return cookie_dict_to_header(cookie_map)


def _cookie_header_looks_logged_in(cookie: str) -> bool:
    cookie_map = cookie_string_to_dict(cookie)
    return bool(cookie_map.get("SESSDATA") and cookie_map.get("DedeUserID"))


def _render_qr_png_base64(content: str) -> str:
    _ensure_qrcode_available()
    img = qrcode.make(content)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


async def _cleanup_qr_sessions_locked() -> None:
    now = time.time()
    expired_ids = [
        session_id
        for session_id, session in _qr_sessions.items()
        if session.closed or (session.created_at + _BILIBILI_QR_SESSION_TTL_S) <= now
    ]
    for session_id in expired_ids:
        session = _qr_sessions.pop(session_id, None)
        if session is None:
            continue
        try:
            await session.client.aclose()
        except Exception:
            logger.warning("failed to close bilibili qr session client: %s", session_id)


async def close_all_bilibili_qr_sessions() -> None:
    async with _qr_sessions_lock:
        sessions = list(_qr_sessions.values())
        _qr_sessions.clear()
    for session in sessions:
        try:
            await session.client.aclose()
        except Exception:
            logger.warning("failed to close bilibili qr session client: %s", session.session_id)


async def start_bilibili_qr_login_session() -> dict[str, Any]:
    _ensure_qrcode_available()
    client = httpx.AsyncClient(
        timeout=20.0,
        follow_redirects=True,
        headers=dict(_BILIBILI_LOGIN_HEADERS),
    )

    try:
        response = await client.get(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
            params={
                "source": "main_web",
                "go_url": "",
                "web_location": "333.1228",
                "x-bili-locale-json": _BILIBILI_LOCALE_JSON,
            },
        )
        response.raise_for_status()
        payload = response.json()
    except Exception:
        await client.aclose()
        raise

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        await client.aclose()
        raise RuntimeError("bilibili qr generate returned invalid response")

    qr_url = str(data.get("url") or "").strip()
    qrcode_key = str(data.get("qrcode_key") or "").strip()
    if not qr_url or not qrcode_key:
        await client.aclose()
        raise RuntimeError("bilibili qr generate returned empty qr data")

    session_id = uuid.uuid4().hex
    session = _BilibiliQrSession(
        session_id=session_id,
        client=client,
        qrcode_key=qrcode_key,
        qr_url=qr_url,
    )
    qr_image_base64 = _render_qr_png_base64(qr_url)

    async with _qr_sessions_lock:
        await _cleanup_qr_sessions_locked()
        _qr_sessions[session_id] = session

    return {
        "session_id": session_id,
        "qrcode_key": qrcode_key,
        "qr_url": qr_url,
        "qr_image_base64": qr_image_base64,
    }


async def _finalize_bilibili_qr_session(session: _BilibiliQrSession, auth_url: str) -> str:
    cookie = _merge_cookie_headers(
        _cookie_header_from_auth_url(auth_url),
        _cookie_header_from_client(session.client),
    )
    if _cookie_header_looks_logged_in(cookie):
        session.authorized_cookie = cookie
        return cookie

    if auth_url:
        try:
            await asyncio.wait_for(
                session.client.get(
                    auth_url,
                    headers={
                        **_BILIBILI_LOGIN_HEADERS,
                        "referer": "https://passport.bilibili.com/login",
                    },
                ),
                timeout=_BILIBILI_QR_FINALIZE_TIMEOUT_S,
            )
        except Exception as exc:
            logger.warning("bilibili qr auth_url finalize failed for %s: %s", session.session_id, exc)

    # Touch nav once so server-side calls can confirm cookies are complete.
    try:
        await asyncio.wait_for(
            session.client.get(
                "https://api.bilibili.com/x/web-interface/nav",
                headers={
                    **_BILIBILI_LOGIN_HEADERS,
                    "referer": "https://www.bilibili.com/",
                },
            ),
            timeout=_BILIBILI_QR_FINALIZE_TIMEOUT_S,
        )
    except Exception as exc:
        logger.warning("bilibili qr nav finalize failed for %s: %s", session.session_id, exc)

    cookie = _merge_cookie_headers(
        _cookie_header_from_auth_url(auth_url),
        _cookie_header_from_client(session.client),
    )
    session.authorized_cookie = cookie
    return cookie


async def poll_bilibili_qr_login_session(session_id: str) -> dict[str, Any]:
    async with _qr_sessions_lock:
        await _cleanup_qr_sessions_locked()
        session = _qr_sessions.get(session_id)
    if session is None:
        raise KeyError("bilibili qr session not found or expired")

    response = await session.client.get(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
        params={
            "qrcode_key": session.qrcode_key,
            "source": "main_web",
            "web_location": "333.1228",
            "x-bili-locale-json": _BILIBILI_LOCALE_JSON,
        },
    )
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError("bilibili qr poll returned invalid response")

    raw_code = data.get("code")
    code = int(raw_code) if raw_code is not None else -1
    message = str(data.get("message") or "")
    auth_url = str(data.get("url") or "").strip()

    if code != 86101:
        logger.info("bilibili qr poll session=%s code=%s message=%s", session_id, code, message or "")

    if code == 0:
        response_cookie = _cookie_header_from_response(response)
        client_cookie = _cookie_header_from_client(session.client)
        url_cookie = _cookie_header_from_auth_url(auth_url)
        cookie = session.authorized_cookie or _merge_cookie_headers(url_cookie, response_cookie, client_cookie)
        if not _cookie_header_looks_logged_in(cookie):
            cookie = await _finalize_bilibili_qr_session(session, auth_url)
        if not _cookie_header_looks_logged_in(cookie):
            logger.warning("bilibili qr authorized but cookie is incomplete for session=%s", session_id)
        async with _qr_sessions_lock:
            finished_session = _qr_sessions.pop(session_id, None)
        if finished_session is not None:
            finished_session.closed = True
            try:
                await finished_session.client.aclose()
            except Exception:
                logger.warning("failed to close authorized bilibili qr session: %s", session_id)
        return {
            "status": "authorized",
            "code": code,
            "message": message or "authorized",
            "auth_url": auth_url,
            "cookie": cookie,
            "refresh_token": str(data.get("refresh_token") or ""),
        }
    if code == 86101:
        return {"status": "waiting", "code": code, "message": message or "waiting"}
    if code in {86039, 86090}:
        return {"status": "scanned", "code": code, "message": message or "scanned"}
    if code == 86038:
        async with _qr_sessions_lock:
            session = _qr_sessions.pop(session_id, None)
        if session is not None:
            try:
                await session.client.aclose()
            except Exception:
                logger.warning("failed to close expired bilibili qr session: %s", session_id)
        return {"status": "expired", "code": code, "message": message or "expired"}
    logger.warning("bilibili qr returned unknown state session=%s payload=%s", session_id, payload)
    return {"status": "unknown", "code": code, "message": message or "unknown", "raw": payload}


def _cookie_string_to_playwright_cookies(cookie: str) -> list[dict[str, Any]]:
    cookie_map = cookie_string_to_dict(cookie)
    cookies: list[dict[str, Any]] = []
    for name, value in cookie_map.items():
        cookies.append(
            {
                "name": name,
                "value": value,
                "domain": ".bilibili.com",
                "path": "/",
                "httpOnly": False,
                "secure": True,
                "sameSite": "Lax",
            }
        )
    return cookies


async def _hover_player(page: Any) -> None:
    try:
        locator = page.locator("video").first
        if await locator.count() == 0:
            return
        box = await locator.bounding_box()
        if not box:
            return
        await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    except Exception:
        return


async def _try_click_selectors(page: Any, selectors: list[str]) -> bool:
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if await locator.count() == 0:
                continue
            await locator.click(timeout=1200)
            return True
        except Exception:
            continue
    return False


async def _try_enable_bilibili_ai_subtitle(page: Any) -> None:
    await _hover_player(page)
    await page.wait_for_timeout(250)
    await _try_click_selectors(
        page,
        [
            ".bpx-player-ctrl-subtitle",
            ".bpx-player-ctrl-subtitle-close-switch",
            "[aria-label*='字幕']",
            "[title*='字幕']",
        ],
    )
    await page.wait_for_timeout(600)
    await _try_click_selectors(
        page,
        [
            "div[data-lan='ai-zh']",
            "div[data-lan='ai-en']",
            "[data-lan='ai-zh']",
            "[data-lan='ai-en']",
            "[data-value='ai-zh']",
            "[data-value='ai-en']",
        ],
    )
    await page.evaluate(
        """
        () => {
          const candidates = Array.from(document.querySelectorAll("div, li, span, button"));
          const target = candidates.find((node) => {
            const text = String(node.textContent || "").trim();
            return /(AI字幕|AI 字幕|自动生成|自动字幕|机器生成|智能字幕)/i.test(text);
          });
          if (target instanceof HTMLElement) target.click();
        }
        """
    )


async def fetch_bilibili_subtitle_candidates_via_playwright(video_id: str, cookie: str) -> list[dict[str, Any]]:
    browser = None
    context = None
    page = None
    playwright = None
    captured_payloads: list[dict[str, Any]] = []

    async def _capture_response(response: Any) -> None:
        url = str(getattr(response, "url", "") or "")
        if not _BILIBILI_SUBTITLE_RESOURCE_RE.search(url):
            return
        try:
            data = await response.json()
        except Exception:
            return
        captured_payloads.append({"url": url, "data": data})

    try:
        _ensure_playwright_available()
        if not cookie.strip():
            return []
        playwright = await async_playwright().start()
        browser = await playwright.chromium.launch(**_get_playwright_launch_kwargs())
        context = await browser.new_context(
            locale="zh-CN",
            viewport={"width": 1440, "height": 900},
            user_agent=_BILIBILI_LOGIN_HEADERS["user-agent"],
        )
        cookies = _cookie_string_to_playwright_cookies(cookie)
        if cookies:
            await context.add_cookies(cookies)

        page = await context.new_page()
        page.on("response", lambda response: asyncio.create_task(_capture_response(response)))
        await page.goto(
            f"https://www.bilibili.com/video/{video_id}",
            wait_until="domcontentloaded",
            timeout=_BILIBILI_PLAYWRIGHT_TIMEOUT_MS,
        )
        await page.wait_for_timeout(2500)
        await _try_enable_bilibili_ai_subtitle(page)
        await page.wait_for_timeout(1500)

        result = await page.evaluate(
            """
            async () => {
              const normalizeUrl = (value) => {
                const raw = String(value || "").trim();
                if (!raw) return "";
                if (raw.startsWith("//")) return `https:${raw}`;
                if (raw.startsWith("http://")) return `https://${raw.slice("http://".length)}`;
                if (raw.startsWith("https://")) return raw;
                return `https://${raw.replace(/^\\/+/, "")}`;
              };

              const collected = [];
              const seen = new Set();
              const pushTracks = (tracks, source) => {
                if (!Array.isArray(tracks)) return;
                tracks.forEach((item, index) => {
                  if (!item || typeof item !== "object") return;
                  const subtitleUrl = normalizeUrl(item.subtitle_url || item.url || "");
                  if (!subtitleUrl || seen.has(subtitleUrl)) return;
                  seen.add(subtitleUrl);
                  const lan = String(item.lan || "").trim();
                  const lanDoc = String(item.lan_doc || item.lang || "").trim();
                  const lowered = `${lan} ${lanDoc}`.toLowerCase();
                  collected.push({
                    subtitle_url: subtitleUrl,
                    lan,
                    lan_doc: lanDoc,
                    order_index: Number.isFinite(index) ? index : 0,
                    is_auto:
                      lan.toLowerCase().startsWith("ai-") ||
                      lowered.includes("自动") ||
                      lowered.includes("auto") ||
                      lowered.includes("ai"),
                    source,
                  });
                });
              };

              const state = window.__INITIAL_STATE__ || {};
              const bvid = state.bvid || state.videoData?.bvid || "";
              const aid = state.aid || state.videoData?.aid || state.videoData?.stat?.aid || 0;
              const cid =
                state.cid ||
                state.videoData?.cid ||
                state.cidMap?.[bvid]?.cids?.[1] ||
                state.cidMap?.[aid]?.cids?.[1] ||
                0;

              const apiDefs = [
                {
                  path: "https://api.bilibili.com/x/player/wbi/v2",
                  params: { aid: String(aid || ""), cid: String(cid || ""), isGaiaAvoided: "false", web_location: "1315873" },
                },
                {
                  path: "https://api.bilibili.com/x/player/v2",
                  params: { aid: String(aid || ""), cid: String(cid || "") },
                },
              ];

              for (const apiDef of apiDefs) {
                try {
                  if (!apiDef.params.aid || !apiDef.params.cid) continue;
                  const url = new URL(apiDef.path);
                  Object.entries(apiDef.params).forEach(([key, value]) => {
                    if (value) url.searchParams.set(key, value);
                  });
                  const response = await fetch(url.toString(), { credentials: "include" });
                  const json = await response.json();
                  const subtitle = json?.data?.subtitle || {};
                  pushTracks(subtitle.subtitles || subtitle.list || [], apiDef.path);
                } catch (error) {
                  void error;
                }
              }

              const resourceUrls = performance
                .getEntriesByType("resource")
                .map((entry) => String(entry?.name || ""))
                .filter((url) => /(aisubtitle\\.hdslb\\.com|subtitle|caption)/i.test(url));

              const extraBodies = [];
              for (const resourceUrl of resourceUrls) {
                if (seen.has(resourceUrl)) continue;
                try {
                  const response = await fetch(resourceUrl, { credentials: "include" });
                  const json = await response.json();
                  if (Array.isArray(json?.body) && json.body.length > 0) {
                    extraBodies.push({ url: resourceUrl, body: json.body });
                  }
                } catch (error) {
                  void error;
                }
              }

              for (const track of collected) {
                try {
                  const response = await fetch(track.subtitle_url, { credentials: "include" });
                  const json = await response.json();
                  track.body = Array.isArray(json?.body) ? json.body : [];
                } catch (error) {
                  track.body = [];
                }
              }

              return { tracks: collected, extraBodies };
            }
            """
        )

        tracks = result.get("tracks") if isinstance(result, dict) else None
        extra_bodies = result.get("extraBodies") if isinstance(result, dict) else None
        candidates: list[dict[str, Any]] = []

        if isinstance(tracks, list):
            for item in tracks:
                if not isinstance(item, dict):
                    continue
                candidates.append(dict(item))

        if isinstance(extra_bodies, list):
            for index, item in enumerate(extra_bodies):
                if not isinstance(item, dict):
                    continue
                body = item.get("body")
                if not isinstance(body, list) or not body:
                    continue
                candidates.append(
                    {
                        "subtitle_url": str(item.get("url") or f"playwright://resource/{index}"),
                        "lan": "ai-auto",
                        "lan_doc": "AI字幕",
                        "order_index": 1000 + index,
                        "is_auto": True,
                        "body": body,
                        "source": "playwright-resource",
                    }
                )

        for index, payload in enumerate(captured_payloads):
            data = payload.get("data")
            if not isinstance(data, dict):
                continue
            body = data.get("body")
            if not isinstance(body, list) or not body:
                continue
            candidates.append(
                {
                    "subtitle_url": str(payload.get("url") or f"playwright://captured/{index}"),
                    "lan": "ai-auto",
                    "lan_doc": "AI字幕",
                    "order_index": 2000 + index,
                    "is_auto": True,
                    "body": body,
                    "source": "playwright-captured",
                }
            )

        deduped: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        for item in candidates:
            subtitle_url = str(item.get("subtitle_url") or "").strip()
            if not subtitle_url or subtitle_url in seen_urls:
                continue
            seen_urls.add(subtitle_url)
            deduped.append(item)
        return deduped
    except PlaywrightTimeoutError as exc:
        logger.warning("playwright subtitle fetch timed out for %s: %s", video_id, exc)
        return []
    except Exception as exc:
        logger.warning("playwright subtitle fetch failed for %s: %s", video_id, exc)
        return []
    finally:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass
        if context is not None:
            try:
                await context.close()
            except Exception:
                pass
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:
                pass
