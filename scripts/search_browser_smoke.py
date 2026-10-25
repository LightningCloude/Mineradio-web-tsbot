#!/usr/bin/env python3
"""Search/online playlist acceptance on loopback assets; queue writes are intercepted."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from urllib.parse import parse_qs, urlparse


def run_search_checks(base_url: str, artifact_dir: Path, *, browse_only: bool = False) -> dict:
    if urlparse(base_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Search mutation fixtures require an isolated loopback origin")
    from playwright.sync_api import sync_playwright
    artifact_dir.mkdir(parents=True, exist_ok=True)
    profiles = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, mobile, reduced in [("desktop", False, False), ("mobile", True, False), ("reduced-motion", False, True)]:
                context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900},
                                              is_mobile=mobile, has_touch=mobile, reduced_motion="reduce" if reduced else "no-preference")
                page = context.new_page()
                page.set_default_timeout(15000)
                checks, writes, searches, details, errors, unexpected = [], [], [], [], [], []
                held_writes = []
                hold_queue = [False]
                page.on("pageerror", lambda error: errors.append(str(error)))

                def fulfill(route, value, status=200):
                    route.fulfill(status=status, content_type="application/json", body=json.dumps(value))

                def api_fixture(route):
                    req = route.request
                    path = urlparse(req.url).path
                    query = parse_qs(urlparse(req.url).query)
                    keyword = query.get("keywords", [""])[0]
                    number = int(query.get("page", [1])[0])
                    if req.method not in {"GET", "HEAD"}:
                        if path == "/api/external/queue" and req.method == "POST":
                            payload = req.post_data_json
                            writes.append({**payload, "at": time.monotonic()})
                            if hold_queue[0]:
                                held_writes.append(route)
                            else:
                                fulfill(route, {"ok": True})
                        else:
                            unexpected.append(req.url)
                            fulfill(route, {"detail": "Unexpected mutation"}, 400)
                        return
                    if path == "/api/external/search":
                        searches.append((keyword, number))
                        if keyword == "empty":
                            fulfill(route, {"items": [], "has_more": False})
                        elif keyword == "error":
                            fulfill(route, {"detail": "fixture unavailable"}, 503)
                        else:
                            items = [{"song_mid": f"song{index}", "title": f"晚风与海 {index}", "artist": "测试歌手", "album": "很长的专辑名称", "duration_ms": 181000, "cover": "/fixture-cover.svg"}
                                     for index in range(20) if number == 1] if number == 1 else [{"song_mid": "song19", "title": "重复项"}, {"song_mid": "song20", "title": "第二页唯一歌曲", "artist": "测试歌手"}]
                            fulfill(route, {"items": items, "has_more": number == 1})
                    elif path == "/api/qqmusic/search":
                        rows = [{"dissid": str(index), "dissname": "夜晚的收藏 &amp; 放松" if index == 1 else "小型导入歌单" if index == 2 else "失效歌单" if index == 3 else "长标题歌单 " * 8,
                                 "creator": {"name": "音乐爱好者"}, "song_count": 65 if index == 1 else 3, "listennum": 76301305,
                                 "imgurl": "/missing-cover.svg" if index == 4 else "/fixture-cover.svg"} for index in range(1, 21)]
                        fulfill(route, {"code": 0, "req": {"code": 0, "data": {"code": 0, "meta": {"sum": 20}, "body": {"songlist": {"list": rows}}}}})
                    elif path.startswith("/api/qqmusic/playlist/"):
                        pid = path.rsplit("/", 1)[-1]
                        details.append(pid)
                        if pid == "3":
                            fulfill(route, {"code": 0, "cdlist": []})
                        else:
                            size = 61 if pid == "1" else 3
                            songs = [{"songmid": f"exact{pid}_{i}" if i else "", "songname": f"同名歌曲 {i}", "singer": [{"name": "歌手"}], "interval": 120} for i in range(size)]
                            fulfill(route, {"code": 0, "cdlist": [{"dissid": pid, "dissname": "夜晚的收藏 &amp; 放松" if pid == "1" else "小型导入歌单", "nickname": "音乐爱好者", "logo": "/fixture-cover.svg", "total_song_num": 65 if pid == "1" else 3, "desc": "简介 &lt;img src=x onerror=alert(1)&gt;", "songlist": songs}]})
                    else:
                        route.continue_()

                page.route("**/api/**", api_fixture)

                def search(value):
                    page.locator('.search-input').fill(value)
                    page.locator('.search-input').press("Enter")

                def fits():
                    panel = page.locator('#search-overlay .search-panel')
                    box = panel.bounding_box()
                    assert box and box['x'] >= 0 and box['y'] >= 0
                    assert box['x'] + box['width'] <= page.viewport_size['width'] + 1
                    assert box['y'] + box['height'] <= page.viewport_size['height'] + 1
                    assert panel.evaluate("node => node.scrollWidth <= node.clientWidth + 1")
                    assert page.locator('.search-results').evaluate("node => node.scrollWidth <= node.clientWidth + 1")

                try:
                    page.goto(base_url, wait_until="domcontentloaded")
                    page.locator('.player-bar').wait_for()
                    reminder = page.locator('#audio-permission-reminder')
                    if reminder.count() and reminder.is_visible():
                        reminder.locator('[data-audio-permission="dismiss"]').click()
                    page.locator('[data-action="search"]').click()
                    page.locator('.search-welcome').wait_for()
                    fits()
                    page.screenshot(path=str(artifact_dir / f"search-{name}-welcome.png"))
                    checks.append("welcome-glass-and-viewport")
                    search("music")
                    page.locator('.search-result-item').nth(19).wait_for()
                    page.locator('[data-search-action="more"]').click()
                    page.locator('.search-result-item').nth(20).wait_for()
                    assert page.locator('.search-result-item').count() == 21
                    checks.append("song-pagination-and-mid-dedup")
                    if not browse_only:
                        page.locator('.sri-add').first.click()
                        page.wait_for_function("() => !document.querySelector('.sri-add').disabled")
                        assert page.locator('#search-overlay').is_visible()
                        page.locator('.sri-playlist').first.click()
                        assert writes[0]['play_now'] is False
                        assert not [item for item in searches if item[0].startswith('exact')]
                        checks.append("continuous-enqueue-and-exact-favorite")
                    page.locator('.search-results').evaluate("node => node.scrollTop = 350")
                    scroll = page.locator('.search-results').evaluate("node => node.scrollTop")
                    page.locator('#search-overlay .search-close').click()
                    page.locator('[data-action="search"]').click()
                    assert page.locator('.search-input').input_value() == 'music'
                    assert abs(page.locator('.search-results').evaluate("node => node.scrollTop") - scroll) < 2
                    page.screenshot(path=str(artifact_dir / f"search-{name}-songs.png"))
                    checks.append("close-reopen-restores-keyword-results-scroll")
                    page.locator('[data-search-type="playlists"]').click()
                    page.locator('.search-playlist-card').nth(19).wait_for()
                    page.locator('[data-playlist-id="4"]').scroll_into_view_if_needed()
                    page.locator('.search-results').evaluate("node => node.scrollTop = 200")
                    page.screenshot(path=str(artifact_dir / f"search-{name}-playlists.png"))
                    page.locator('[data-playlist-id="1"]').click()
                    page.locator('.search-result-item').nth(49).wait_for()
                    assert page.locator('.search-result-item').count() == 50
                    assert '61 / 65' in page.locator('.search-playlist-hero').inner_text()
                    assert page.locator('.search-song-unavailable').count() == 1
                    assert page.locator('.search-playlist-description img').count() == 0
                    page.locator('[data-search-action="more-detail"]').click()
                    assert page.locator('.search-result-item').count() == 61
                    fits()
                    page.locator('.search-results').evaluate("node => node.scrollTop = 0")
                    page.screenshot(path=str(artifact_dir / f"search-{name}-detail.png"))
                    page.locator('.search-back').click()
                    page.locator('[data-playlist-id="1"]').click()
                    page.locator('.search-playlist-hero').wait_for()
                    assert details.count('1') == 1
                    checks.append("detail-chunking-partial-invalid-id-safe-text-and-cache")
                    page.locator('.search-back').click()
                    page.locator('[data-playlist-id="3"]').click()
                    page.locator('[data-search-action="retry-detail"]').wait_for()
                    page.locator('.search-back').click()
                    assert page.locator('.search-playlist-card').count() == 20
                    checks.append("unavailable-playlist-can-return")
                    if not browse_only:
                        page.locator('[data-playlist-id="2"]').click()
                        page.locator('.search-playlist-hero').wait_for()
                        page.locator('[data-search-action="save-playlist"]').click()
                        assert page.locator('[data-search-action="save-playlist"]').is_disabled()
                        before = len(writes)
                        page.locator('[data-search-action="append-playlist"]').click()
                        page.wait_for_function("() => document.querySelector('.search-import-progress').textContent.includes('导入完成')")
                        batch = writes[before:]
                        assert [item['song_mid'] for item in batch] == ['exact2_1', 'exact2_2']
                        assert all(item['play_now'] is False for item in batch)
                        assert batch[1]['at'] - batch[0]['at'] >= .27
                        before = len(writes)
                        page.locator('[data-search-action="play-playlist"]').click()
                        page.wait_for_function("() => document.querySelector('.search-import-progress').textContent.includes('导入完成')")
                        assert [item['play_now'] for item in writes[before:]] == [True, False]
                        checks.append("direct-id-import-rate-limit-and-play-all")
                        hold_queue[0] = True
                        before = len(writes)
                        page.locator('[data-search-action="append-playlist"]').click()
                        deadline = time.monotonic() + 15
                        while not held_writes and time.monotonic() < deadline:
                            page.wait_for_timeout(30)
                        assert len(held_writes) == 1
                        page.locator('#search-overlay .search-close').click()
                        page.locator('[data-action="queue"]').click()
                        assert page.locator('.playlist-card-import:disabled').count() > 0
                        page.locator('.playlist-import-resume').click()
                        page.locator('.playlist-import-stop').click()
                        hold_queue[0] = False
                        fulfill(held_writes.pop(), {"ok": True})
                        page.wait_for_function("() => document.querySelector('.playlist-import-status').textContent.includes('已停止')")
                        assert len(writes) - before == 1
                        page.locator('.mini-queue-back').click()
                        before_searches = len(searches)
                        before_writes = len(writes)
                        page.get_by_role('button', name='导入歌单：小型导入歌单', exact=True).click()
                        page.wait_for_function("() => document.querySelector('.playlist-import-status').textContent.includes('导入完成')")
                        assert len(searches) == before_searches
                        assert [item['song_mid'] for item in writes[before_writes:]] == ['exact2_1', 'exact2_2']
                        page.locator('.mini-queue-back').click()
                        page.locator('.mini-queue-close').click()
                        page.locator('[data-action="search"]').click()
                        checks.append("cross-panel-batch-lock-stop-and-saved-direct-import")
                        saved = page.evaluate("JSON.parse(localStorage.getItem('minerats-playlists-v2'))")
                        assert len([item for item in saved if item.get('sourcePlaylistId') == '2']) == 1
                        page.locator('#search-overlay .search-close').click()
                        page.locator('[data-action="queue"]').click()
                        page.locator('.playlist-card-item').first.wait_for()
                        checks.append("saved-online-playlist-visible-in-library")
                        page.locator('.mini-queue-close').click()
                        page.locator('[data-action="search"]').click()
                    page.locator('.search-clear').click()
                    page.locator('.search-welcome').wait_for()
                    page.locator('[data-search-type="songs"]').click()
                    search('empty')
                    page.locator('.search-empty').wait_for()
                    assert '过期' not in page.locator('.search-results').inner_text()
                    search('error')
                    page.locator('[data-search-action="retry"]').wait_for()
                    checks.append("empty-is-not-auth-failure-and-errors-can-retry")
                    fits()
                    # Simulate the reduced visual viewport reported when a mobile keyboard opens.
                    if mobile:
                        page.locator('#search-overlay').evaluate("node => node.style.setProperty('--search-viewport-height', '380px')")
                        assert page.locator('#search-overlay .search-panel').bounding_box()['height'] <= 348 + 1
                    page.locator('#search-overlay .search-close').focus()
                    page.keyboard.press('Shift+Tab')
                    assert page.evaluate("document.querySelector('#search-overlay').contains(document.activeElement)")
                    page.keyboard.press('Escape')
                    assert not page.locator('#search-overlay').is_visible()
                    assert page.locator('[data-action="search"]').evaluate('node => node === document.activeElement')
                    if not browse_only:
                        page.reload(wait_until='domcontentloaded')
                        page.locator('.player-bar').wait_for()
                        reloaded = page.evaluate("JSON.parse(localStorage.getItem('minerats-playlists-v2'))")
                        assert reloaded == saved
                        checks.append("structured-playlists-persist-after-reload")
                    assert not errors and not unexpected, (errors, unexpected)
                    checks.append("keyboard-focus-escape-and-no-runtime-errors")
                    profiles.append({"profile": name, "ok": True, "checks": checks, "mock_queue_writes": len(writes), "real_queue_writes": 0})
                except Exception as exc:
                    page.screenshot(path=str(artifact_dir / f"search-{name}-failure.png"))
                    profiles.append({"profile": name, "ok": False, "checks": checks, "error": str(exc), "page_errors": errors})
                finally:
                    context.close()
        finally:
            browser.close()
    return {"ok": all(profile['ok'] for profile in profiles), "isolated_mock_writes": True, "profiles": profiles}


def run_public_checks(base_url: str, artifact_dir: Path) -> dict:
    """Only search, view and return; block every API write on the production origin."""
    from playwright.sync_api import sync_playwright
    artifact_dir.mkdir(parents=True, exist_ok=True)
    profiles = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for mobile in (False, True):
                name = 'mobile' if mobile else 'desktop'
                context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900}, is_mobile=mobile, has_touch=mobile)
                page = context.new_page()
                page.set_default_timeout(30000)
                blocked, errors = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))

                def guard(route):
                    if route.request.method not in {'GET', 'HEAD'}:
                        blocked.append(route.request.url)
                        route.abort()
                    else:
                        route.continue_()

                page.route('**/api/**', guard)
                try:
                    page.goto(base_url, wait_until='domcontentloaded')
                    page.locator('.player-bar').wait_for()
                    reminder = page.locator('#audio-permission-reminder')
                    if reminder.count() and reminder.is_visible():
                        reminder.locator('[data-audio-permission="dismiss"]').click()
                    page.locator('[data-action="search"]').click()
                    page.locator('[data-search-type="playlists"]').click()
                    page.locator('.search-input').fill('轻音乐')
                    page.locator('.search-input').press('Enter')
                    page.locator('.search-playlist-card').first.wait_for()
                    results = page.locator('.search-playlist-card').count()
                    page.screenshot(path=str(artifact_dir / f'public-search-{name}-playlists.png'))
                    page.locator('.search-playlist-card').first.click()
                    page.locator('.search-playlist-hero').wait_for()
                    assert page.locator('.search-result-item').count() > 0
                    page.screenshot(path=str(artifact_dir / f'public-search-{name}-detail.png'))
                    page.locator('.search-back').click()
                    assert page.locator('.search-playlist-card').count() == results
                    page.locator('#search-overlay .search-close').click()
                    page.locator('[data-action="search"]').click()
                    assert page.locator('.search-input').input_value() == '轻音乐'
                    assert not blocked and not errors, (blocked, errors)
                    profiles.append({"profile": name, "ok": True, "results": results, "checks": ["live-playlist-search", "live-detail", "return-and-reopen"], "api_writes": 0})
                except Exception as exc:
                    page.screenshot(path=str(artifact_dir / f'public-search-{name}-failure.png'))
                    profiles.append({"profile": name, "ok": False, "error": str(exc), "blocked_writes": blocked, "page_errors": errors})
                finally:
                    context.close()
        finally:
            browser.close()
    return {"ok": all(profile['ok'] for profile in profiles), "production_readonly": True, "profiles": profiles}


def main():
    if __package__:
        from .ci_browser_smoke import fixture_server
    else:
        from ci_browser_smoke import fixture_server
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=Path(__file__).resolve().parents[1] / 'web/dist')
    parser.add_argument('--report', type=Path, default=Path('artifacts/search-browser/report.json'))
    parser.add_argument('--browse-only', action='store_true')
    parser.add_argument('--public-url', help='Read-only production search acceptance; blocks API writes')
    args = parser.parse_args()
    if args.public_url:
        report = run_public_checks(args.public_url, args.report.parent)
    else:
        with fixture_server(args.dist.resolve()) as base_url:
            report = run_search_checks(base_url, args.report.parent, browse_only=args.browse_only)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
