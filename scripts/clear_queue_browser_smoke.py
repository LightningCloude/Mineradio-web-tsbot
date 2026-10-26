#!/usr/bin/env python3
"""Loopback-only Chromium checks; ALL API writes are intercepted in memory."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

if __package__:
    from .ci_browser_smoke import fixture_server, SONGS
else:
    from ci_browser_smoke import fixture_server, SONGS


def run_clear_checks(base_url, artifact_dir):
    if urlparse(base_url).hostname not in {"127.0.0.1", "localhost"}:
        raise ValueError("Destructive fixtures may only target loopback")
    artifact_dir = Path(artifact_dir); artifact_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for name, mobile, reduced in (("desktop", False, False), ("mobile", True, False), ("reduced-motion", False, True)):
                context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900},
                    is_mobile=mobile, has_touch=mobile, reduced_motion="reduce" if reduced else "no-preference")
                page = context.new_page(); errors = []; writes = []; held_delete = []; held_post = []
                queue = [dict(SONGS[0], id=index, title=f"Queue {index}") for index in range(1, 1001)]
                mode = ["hold"]; hold_post = [False]; checks = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                def fulfill(route, value, status=200):
                    route.fulfill(status=status, content_type="application/json", body=json.dumps(value))
                def api_fixture(route):
                    req = route.request; path = urlparse(req.url).path
                    if req.method not in {"GET", "HEAD"}:
                        writes.append((req.method, req.url))
                        if path == "/api/external/queue" and req.method == "DELETE":
                            assert urlparse(req.url).query == "stop_playback=false"
                            if mode[0] == "hold": held_delete.append(route)
                            elif mode[0] == "offline": route.abort("failed")
                            else: fulfill(route, {"detail": "fixture database busy"}, 503)
                        elif path == "/api/external/queue" and req.method == "POST" and hold_post[0]: held_post.append(route)
                        else: fulfill(route, {"detail": "Unexpected write"}, 400)
                    elif path == "/api/external/queue": fulfill(route, {"items": queue})
                    elif path == "/api/external/status": fulfill(route, {"state": "paused", "track_id": 1, "current_time": 42,
                        "duration": 180, "now_playing_title": SONGS[0]["title"], "now_playing_artist": "Isolated fixture", "queue_preview": queue[:10], "volume_percent": 10})
                    else: route.continue_()
                page.route("**/api/**", api_fixture)
                page.route_web_socket("**/ws/status", lambda ws: ws.send(json.dumps({"type": "progress", "state": "paused", "position": 42, "song": SONGS[0]})))
                context.add_init_script("localStorage.setItem('minerats-playlists-v2', JSON.stringify([{id:'clear-test',name:'清空并发测试',songs:'one\\ntwo',entries:[{kind:'song',song_mid:'one',title:'one',line:'one'},{kind:'song',song_mid:'two',title:'two',line:'two'}]}]));")
                try:
                    page.goto(base_url, wait_until="networkidle")
                    page.locator('[data-action="clear-queue"]').wait_for()
                    page.wait_for_function("document.querySelector('.player-title').textContent !== '等待播放...'")
                    trigger = page.locator('[data-action="clear-queue"]')
                    trigger.click(); dialog = page.locator('.queue-clear-dialog'); cancel = dialog.locator('.queue-clear-cancel'); confirm = dialog.locator('.queue-clear-confirm')
                    assert dialog.is_visible() and "1000" in dialog.inner_text()
                    assert "当前歌曲继续播放" in dialog.inner_text()
                    assert cancel.evaluate("el => el === document.activeElement")
                    page.keyboard.press("Shift+Tab"); assert confirm.evaluate("el => el === document.activeElement")
                    page.keyboard.press("Tab"); assert cancel.evaluate("el => el === document.activeElement")
                    page.keyboard.press("Escape"); assert not dialog.is_visible()
                    assert trigger.evaluate("el => el === document.activeElement") and not writes
                    checks.append("confirmation, scope, default cancel, focus trap, Escape and focus restoration")
                    trigger.click()
                    bounds = dialog.bounding_box(); assert bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= page.viewport_size["width"] + 1
                    assert abs(bounds["x"] + bounds["width"] / 2 - page.viewport_size["width"] / 2) < 2
                    assert abs(bounds["y"] + bounds["height"] / 2 - page.viewport_size["height"] / 2) < 2
                    page.screenshot(path=str(artifact_dir / f"{name}-confirm.png"))
                    confirm.click(); page.wait_for_function("document.querySelector('.queue-clear-dialog').getAttribute('aria-busy') === 'true'")
                    assert confirm.is_disabled() and cancel.is_disabled() and "正在清空" in dialog.inner_text()
                    page.wait_for_timeout(80); assert len(held_delete) == 1 and len(writes) == 1
                    page.keyboard.press("Escape"); assert dialog.is_visible()
                    page.screenshot(path=str(artifact_dir / f"{name}-busy.png"))
                    queue[:] = [dict(SONGS[0], id=1001, title="New user's song")]
                    fulfill(held_delete.pop(), {"ok": True, "removed_count": 1000, "playback_stopped": False})
                    dialog.wait_for(state="hidden")
                    assert page.locator('.player-time.current').inner_text() == "00:42"
                    assert page.locator('.player-title').inner_text() == SONGS[0]["title"]
                    assert len(writes) == 1
                    trigger.click(); assert "1 首" in dialog.inner_text(); cancel.click()
                    checks.append("single bulk request for 1000 songs, painted busy state, duplicate guard, preserved playback, concurrent addition")
                    mode[0] = "offline"; trigger.click(); confirm.click()
                    page.wait_for_function("document.querySelector('.queue-clear-status').textContent.includes('未自动重试')")
                    assert not confirm.is_visible(); page.wait_for_timeout(100); assert len(writes) == 2
                    assert dialog.is_visible(); page.screenshot(path=str(artifact_dir / f"{name}-uncertain.png")); cancel.click()
                    checks.append("uncertain write remains visible and is never automatically retried")
                    mode[0] = "http-error"; trigger.click(); confirm.click()
                    page.wait_for_function("document.querySelector('.queue-clear-status').textContent.includes('fixture database busy')")
                    assert len(writes) == 3; cancel.click()
                    checks.append("explicit backend failure preserves error text")
                    # Start a real UI import, but hold its fake first write.
                    mode[0] = "hold"; hold_post[0] = True
                    page.locator('[data-action="queue"]').click()
                    page.locator('.playlist-card-import[data-id="clear-test"]').click()
                    page.wait_for_timeout(80); assert len(held_post) == 1
                    trigger.click(); assert confirm.inner_text() == "停止导入并清空"
                    confirm.click(); page.wait_for_timeout(80); assert len(held_delete) == 0
                    fulfill(held_post.pop(), {"ok": True, "id": 1002})
                    page.wait_for_function("document.querySelector('.queue-clear-dialog').getAttribute('aria-busy') === 'true'")
                    page.wait_for_timeout(100); assert len(held_delete) == 1
                    queue.clear(); fulfill(held_delete.pop(), {"ok": True, "removed_count": 2})
                    dialog.wait_for(state="hidden")
                    assert len([item for item in writes if item[0] == "POST"]) == 1
                    assert len([item for item in writes if item[0] == "DELETE"]) == 4
                    trigger.click(); assert not dialog.is_visible()
                    assert "队列已经为空" in page.locator('body').inner_text()
                    checks.append("stop and drain current import before clear, block further imports, empty queue feedback")
                    assert not [item for item in writes if urlparse(item[1]).path != "/api/external/queue"]
                    assert not errors, errors
                    if reduced:
                        trigger.click()
                        assert page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")
                    checks.append("no unexpected writes or browser errors; responsive/reduced-motion layout")
                    reports.append({"profile": name, "ok": True, "checks": checks, "mock_writes": len(writes), "real_writes": 0})
                except Exception:
                    page.screenshot(path=str(artifact_dir / f"{name}-failure.png")); raise
                finally: context.close()
        finally: browser.close()
    return {"ok": True, "isolated": True, "profiles": reports}


def run_public_dialog_checks(base_url, artifact_dir):
    """Open/cancel only. Defense-in-depth rejects every API mutation."""
    artifact_dir = Path(artifact_dir); artifact_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for mobile in (False, True):
                profile = 'mobile' if mobile else 'desktop'
                context = browser.new_context(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900}, is_mobile=mobile, has_touch=mobile)
                page = context.new_page(); writes = []; errors = []
                def readonly(route):
                    if route.request.method not in {'GET', 'HEAD', 'OPTIONS'}:
                        writes.append(route.request.url); route.abort('blockedbyclient')
                    else: route.continue_()
                page.route('**/api/**', readonly)
                page.on('pageerror', lambda error: errors.append(str(error)))
                try:
                    page.goto(base_url, wait_until='networkidle')
                    page.wait_for_function("document.querySelector('.player-title').textContent !== '等待播放...'")
                    trigger = page.locator('[data-action="clear-queue"]'); trigger.click()
                    dialog = page.locator('.queue-clear-dialog'); dialog.wait_for(state='visible')
                    assert '影响所有用户的共享队列' in dialog.inner_text()
                    assert dialog.locator('.queue-clear-cancel').evaluate('el => el === document.activeElement')
                    bounds = dialog.bounding_box()
                    assert abs(bounds['x'] + bounds['width'] / 2 - page.viewport_size['width'] / 2) < 2
                    page.screenshot(path=str(artifact_dir / f'public-{profile}-confirm.png'))
                    page.keyboard.press('Escape'); dialog.wait_for(state='hidden')
                    assert trigger.evaluate('el => el === document.activeElement')
                    assert not writes and not errors
                    reports.append({'profile': profile, 'ok': True, 'checks': ['live modal content and focus', 'centered layout', 'cancel and focus restoration'], 'api_writes': 0})
                finally: context.close()
        finally: browser.close()
    return {'ok': True, 'readonly': True, 'profiles': reports}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=Path("artifacts/clear-queue-browser/report.json"))
    parser.add_argument('--public-url', help='Read-only open/cancel acceptance; never confirms a production clear')
    arguments = parser.parse_args()
    if arguments.public_url:
        result = run_public_dialog_checks(arguments.public_url, arguments.report.parent)
    else:
        with fixture_server(Path(__file__).resolve().parents[1] / "web" / "dist") as url:
            result = run_clear_checks(url, arguments.report.parent)
    arguments.report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__": main()
