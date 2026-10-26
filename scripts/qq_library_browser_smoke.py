"""Loopback-only shared QQ library regressions. No real credentials or queue writes."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

if __package__:
    from .clear_queue_browser_smoke import wait_for_fixture
else:
    from clear_queue_browser_smoke import wait_for_fixture


def run_library_checks(base_url, artifact_dir):
    if urlparse(base_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Library write fixtures require isolated loopback")
    artifact_dir = Path(artifact_dir); artifact_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for name, mobile, reduced in (("desktop", False, False), ("mobile", True, False), ("reduced-motion", False, True)):
                context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900},
                    is_mobile=mobile, has_touch=mobile, reduced_motion="reduce" if reduced else "no-preference")
                page = context.new_page(); page.set_default_timeout(15000)
                checks = []; errors = []; posts = []; reads = []; writes = []; held = []
                mode = ["ready"]; version = ["A"]; hold = [False]
                page.on("pageerror", lambda error: errors.append(str(error)))
                context.add_init_script("""if (!localStorage.getItem('minerats-playlists-v2')) localStorage.setItem('minerats-playlists-v2', JSON.stringify([{id:'local',name:'原本的本地收藏',songs:'existing',cover:''}]));""")
                def fulfill(route, value, status=200):
                    route.fulfill(status=status, content_type="application/json", body=json.dumps(value))
                def directory():
                    return {"status": "ready", "account_id": "account" + version[0], "account_version": version[0], "complete": True,
                        "items": [{"id": "99", "kind": "liked", "name": "我喜欢的音乐", "songCount": 3, "cover": "/broken-cover.png"},
                                  {"id": "200", "kind": "created", "name": "长标题与部分结果测试 " * 5, "songCount": 55, "cover": "/fixture-cover.svg"},
                                  {"id": "300", "kind": "created", "name": "空歌单", "songCount": 0, "cover": ""}]}
                def details(identifier):
                    songs = [] if identifier == "300" else [
                        {"songmid": f"EXACT_{index}", "songname": "同名不同版本" if identifier == "99" else f"大歌单歌曲 {index}",
                         "singer": [{"name": "夹具歌手"}], "interval": 123} for index in range(2 if identifier == "99" else 52)]
                    if identifier == "99": songs.append({"songname": "缺少 ID 的歌曲", "interval": 120})
                    item = next(item for item in directory()["items"] if item["id"] == identifier)
                    return {"status": "ready", "account_id": "account" + version[0], "account_version": version[0], "playlist": item,
                        "data": {"code": 0, "cdlist": [{"dissid": identifier, "dissname": item["name"], "logo": item["cover"], "total_song_num": item["songCount"], "songlist": songs}]}}
                def api(route):
                    request = route.request; path = urlparse(request.url).path
                    if request.method not in {"GET", "HEAD"}:
                        writes.append((request.method, path))
                        if path == "/api/external/queue" and request.method == "POST":
                            posts.append(request.post_data_json); fulfill(route, {"ok": True})
                        elif path == "/api/admin/qqmusic/cookie" and request.method == "DELETE":
                            mode[0] = "unconfigured"; fulfill(route, {"ok": True, "admin_cookie_set": False})
                        else: fulfill(route, {"detail": "Unexpected fixture write"}, 400)
                    elif path == "/api/qqmusic/library":
                        reads.append(path)
                        if hold[0]: held.append(route)
                        else: fulfill(route, directory() if mode[0] == "ready" else {"status": mode[0], "items": []})
                    elif path.startswith('/api/qqmusic/library/playlists/'):
                        reads.append(path); fulfill(route, details(path.rsplit('/', 1)[1]))
                    else: route.continue_()
                page.route('**/api/**', api)
                page.route('**/broken-cover.png', lambda route: route.fulfill(status=404))
                try:
                    page.goto(base_url, wait_until="networkidle")
                    reminder = page.locator('#audio-permission-reminder')
                    if reminder.count() and reminder.is_visible(): reminder.locator('[data-audio-permission="dismiss"]').click()
                    page.locator('[data-action="queue"]').click()
                    expect(page.locator('[data-qq-id]')).to_have_count(3)
                    assert reads == ['/api/qqmusic/library'] and not writes
                    assert page.locator('.playlist-card-item').count() == 1
                    assert "共享账号" in page.locator('.qq-library').inner_text()
                    checks.append('automatic metadata-only directory, shared label, separate local favorites')
                    bounds = page.locator('#queue-panel').bounding_box()
                    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= page.viewport_size['width'] + 1
                    assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= page.viewport_size['height'] + 1
                    page.screenshot(path=str(artifact_dir / f'{name}-library.png'))
                    checks.append('desktop/mobile black glass layout without overflow')
                    page.locator('[data-qq-id="99"]').click()
                    expect(page.locator('.qq-library-track')).to_have_count(3)
                    assert '不可导入' in page.locator('.qq-library-detail').inner_text()
                    page.locator('[data-qq-action="save"]').click()
                    expect(page.locator('[data-qq-action="save"]')).to_have_text('已另存到本地')
                    saved = page.evaluate("JSON.parse(localStorage.getItem('minerats-playlists-v2'))")
                    assert len(saved) == 2 and saved[0]['songs'] == 'existing'
                    assert [entry['song_mid'] for entry in saved[1]['entries']][:2] == ['EXACT_0', 'EXACT_1']
                    assert not posts
                    checks.append('exact-version local snapshot, invalid MID labeling and original default preserved')
                    page.locator('[data-qq-action="append"]').click()
                    page.wait_for_function("document.querySelector('.playlist-import-status').textContent.includes('导入完成')")
                    assert len(posts) == 2 and all(not item['play_now'] for item in posts)
                    assert [item['song_mid'] for item in posts] == ['EXACT_0', 'EXACT_1']
                    checks.append('append exact IDs without name search or playback interruption')
                    page.locator('.mini-queue-back').click(); page.locator('[data-qq-id="99"]').click()
                    expect(page.locator('.qq-library-track')).to_have_count(3)
                    page.locator('[data-qq-action="play"]').click()
                    wait_for_fixture(page, lambda: len(posts) == 4, 'play-all queue writes')
                    page.wait_for_function("document.querySelector('.playlist-import-status').textContent.includes('导入完成')")
                    assert len(posts) == 4 and [item['play_now'] for item in posts[2:]] == [True, False]
                    checks.append('play all starts first successful song once; shared importer releases')
                    page.locator('.mini-queue-back').click(); page.locator('[data-qq-id="200"]').click()
                    expect(page.locator('.qq-library-track')).to_have_count(50)
                    assert page.locator('[data-qq-action="append"]').is_disabled()
                    assert page.locator('[data-qq-action="save"]').is_disabled()
                    page.locator('[data-qq-action="more"]').click()
                    expect(page.locator('.qq-library-track')).to_have_count(52)
                    page.locator('[data-qq-partial]').check()
                    assert page.locator('[data-qq-action="append"]').is_enabled()
                    page.screenshot(path=str(artifact_dir / f'{name}-detail.png'))
                    checks.append('50-row window, more, and explicit partial-result confirmation')
                    page.locator('.mini-queue-back').click()
                    assert page.locator('[data-qq-id="200"]').evaluate('node => node === document.activeElement')
                    page.locator('[data-qq-id="300"]').click()
                    expect(page.locator('.qq-library-summary')).to_be_visible()
                    assert page.locator('[data-qq-action="append"]').is_disabled()
                    checks.append('return focus and empty playlist with disabled actions')
                    page.locator('.mini-queue-back').click()
                    page.locator('.mini-queue-paste').click(); page.locator('.playlist-paste-name').fill('保留的草稿')
                    page.locator('.playlist-paste-input').fill('draft song')
                    # Switch account in a different visitor, then reopen and explicitly refresh.
                    page.locator('.playlist-paste-cancel').click(); version[0] = 'B'
                    page.locator('[data-qq-action="refresh"]').click()
                    expect(page.locator('.qq-library-status')).to_contain_text('3 个歌单')
                    page.locator('[data-qq-id="99"]').click(); expect(page.locator('.qq-library-track')).to_have_count(3)
                    assert len([path for path in reads if path.endswith('/playlists/99')]) == 2
                    assert len(posts) == 4
                    checks.append('account switch invalidates detail cache without automatic writes')
                    page.locator('.mini-queue-back').click(); mode[0] = 'unavailable'
                    page.locator('[data-qq-action="refresh"]').click()
                    expect(page.locator('.qq-library-status')).to_contain_text('暂时无法')
                    expect(page.locator('[data-qq-id]')).to_have_count(3)
                    checks.append('refresh failure keeps last verified directory and reports error')
                    mode[0] = 'expired'; page.locator('[data-qq-action="refresh"]').click()
                    expect(page.locator('.qq-library-status')).to_contain_text('失效')
                    expect(page.locator('[data-qq-id]')).to_have_count(0)
                    assert len(page.evaluate("JSON.parse(localStorage.getItem('minerats-playlists-v2'))")) == 2
                    checks.append('expired login hides remote entries, preserves local copies, no token prompt')
                    mode[0] = 'ready'; hold[0] = True; page.locator('[data-qq-action="refresh"]').click()
                    page.locator('.mini-queue-paste').click()
                    assert page.locator('.playlist-paste-name').input_value() == '保留的草稿'
                    page.wait_for_function("document.querySelector('.qq-library-status').textContent.includes('正在同步')")
                    wait_for_fixture(page, lambda: len(held) == 1, 'held library metadata read')
                    fulfill(held.pop(), directory()); hold[0] = False
                    expect(page.locator('.qq-library-status')).to_contain_text('3 个歌单')
                    assert page.locator('.playlist-paste-area').is_visible()
                    assert page.locator('.playlist-paste-input').input_value() == 'draft song'
                    checks.append('background sync never changes view or editor draft')
                    page.keyboard.press('Escape'); assert not page.locator('#queue-panel').evaluate("node => node.classList.contains('show')")
                    assert not errors, errors
                    assert all(path in {'/api/external/queue', '/api/admin/qqmusic/cookie'} for _, path in writes)
                    reports.append({'profile': name, 'ok': True, 'checks': checks, 'queue_writes_intercepted': len(posts), 'errors': errors})
                finally:
                    for route in held:
                        try: route.abort()
                        except Exception: pass
                    context.close()
        finally: browser.close()
    return {'ok': all(report['ok'] for report in reports), 'isolated': True, 'profiles': reports}


if __name__ == '__main__':
    if __package__:
        from .ci_browser_smoke import fixture_server
    else:
        from ci_browser_smoke import fixture_server
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=Path('web/dist'))
    parser.add_argument('--artifacts', type=Path, default=Path('artifacts/qq-library-browser'))
    arguments = parser.parse_args()
    with fixture_server(arguments.dist.resolve()) as origin:
        result = run_library_checks(origin, arguments.artifacts)
    (arguments.artifacts / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
