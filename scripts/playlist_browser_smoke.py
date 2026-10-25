#!/usr/bin/env python3
"""Playlist navigation regression using isolated assets and intercepted queue writes."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from urllib.parse import parse_qs, urlparse


def run_playlist_checks(base_url: str, artifact_dir: Path) -> dict:
    # Never run simulated import/play-now actions against a production origin.
    if urlparse(base_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Playlist mutation fixtures require an isolated loopback origin")
    from playwright.sync_api import sync_playwright

    artifact_dir.mkdir(parents=True, exist_ok=True)
    profiles = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for mobile in (False, True):
                name = "mobile" if mobile else "desktop"
                context = browser.new_context(
                    viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900},
                    is_mobile=mobile, has_touch=mobile,
                )
                checks = []
                writes = []
                pending = []
                unexpected_writes = []
                page = context.new_page()
                page.set_default_timeout(15000)

                def item(keyword):
                    return {"song_mid": keyword.replace(" ", "_"), "title": keyword, "artist": "回归测试", "cover": "/fixture-cover.svg", "duration_ms": 180000}

                def fulfill(route, payload, status=200):
                    route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))

                def search(route):
                    keyword = parse_qs(urlparse(route.request.url).query).get("keywords", [""])[0]
                    if keyword == "hold":
                        pending.append(route)
                    elif keyword == "missing":
                        fulfill(route, {"items": []})
                    elif keyword == "search-error":
                        fulfill(route, {"detail": "isolated search error"}, 500)
                    else:
                        fulfill(route, {"items": [item(keyword)]})

                def queue(route):
                    if route.request.method == "POST":
                        payload = route.request.post_data_json
                        writes.append(payload)
                        if payload.get("song_mid") == "queue-error":
                            fulfill(route, {"detail": "isolated queue error"}, 500)
                        else:
                            fulfill(route, {"ok": True})
                    else:
                        route.continue_()

                def wait_pending():
                    deadline = time.monotonic() + 15
                    while not pending and time.monotonic() < deadline:
                        page.wait_for_timeout(50)
                    assert len(pending) == 1, "Import should have one sequential pending search"

                def complete():
                    page.wait_for_function("() => document.querySelector('.playlist-import-status').textContent.includes('导入完成')")

                def create(title, songs):
                    page.locator('.mini-queue-paste').click()
                    page.locator('.playlist-paste-name').fill(title)
                    page.locator('.playlist-paste-input').fill(songs)
                    page.locator('.playlist-paste-confirm').click()

                def start(title):
                    page.get_by_role("button", name=f"导入歌单：{title}", exact=True).click()

                page.route("**/api/external/search?**", search)
                page.route("**/api/external/queue", queue)
                page.on("request", lambda request: unexpected_writes.append(request.url)
                        if request.method not in ("GET", "HEAD") and urlparse(request.url).path != "/api/external/queue" else None)
                try:
                    page.goto(base_url, wait_until="domcontentloaded")
                    page.locator('.player-bar').wait_for()
                    reminder = page.locator('#audio-permission-reminder')
                    if reminder.count() and reminder.is_visible():
                        reminder.locator('[data-audio-permission="dismiss"]').click()
                    page.locator('[data-action="queue"]').click()
                    page.locator('.mini-queue-empty').wait_for(state="visible")
                    checks.append("empty-state")
                    create("夜行歌单", "song one\nsong two")
                    create("通勤收藏", "song three")
                    create("部分失败测试", "missing\nsearch-error\nqueue-error\ngood")
                    create("后台导入测试", "hold")
                    assert page.locator('.playlist-card-item').count() == 4
                    box = page.locator('#queue-panel').bounding_box()
                    assert box and box['x'] >= 0 and box['y'] >= 0
                    assert box['x'] + box['width'] <= page.viewport_size['width'] + 1
                    assert box['y'] + box['height'] <= page.viewport_size['height'] + 1
                    bar_box = page.locator('.player-bar').bounding_box()
                    assert box['y'] + box['height'] <= bar_box['y'] - 8, 'Playlist overlaps playback controls'
                    page.wait_for_timeout(250)
                    page.screenshot(path=str(artifact_dir / f"playlist-{name}-library.png"))
                    checks.append("create-lists-and-viewport-fit")
                    start("夜行歌单")
                    complete()
                    assert page.locator('#queue-panel').evaluate("node => node.classList.contains('show')")
                    assert [entry['play_now'] for entry in writes] == [True, False]
                    page.screenshot(path=str(artifact_dir / f"playlist-{name}-import.png"))
                    page.locator('.mini-queue-back').click()
                    start("通勤收藏")
                    complete()
                    assert len(writes) == 3
                    checks.append("back-and-second-import")
                    page.locator('.playlist-import-back').click()
                    start("部分失败测试")
                    complete()
                    assert page.locator('.import-status.fail').count() == 3
                    assert page.locator('.import-status.ok').count() == 1
                    checks.append("partial-failure-releases-lock")
                    page.locator('.mini-queue-back').click()
                    start("后台导入测试")
                    wait_pending()
                    page.locator('.mini-queue-back').click()
                    assert page.locator('.playlist-card-import:disabled').count() == 4
                    page.locator('.playlist-import-resume').click()
                    page.locator('.playlist-import-create').click()
                    page.locator('.playlist-paste-name').fill("保留草稿")
                    page.locator('.playlist-paste-input').fill("draft song")
                    fulfill(pending.pop(), {"items": [item("hold")]})
                    complete()
                    assert page.locator('.playlist-paste-area').is_visible()
                    assert page.locator('.playlist-paste-name').input_value() == "保留草稿"
                    assert page.locator('.playlist-paste-input').input_value() == "draft song"
                    checks.append("background-import-keeps-draft-and-progress")
                    page.locator('.playlist-paste-cancel').click()
                    start("后台导入测试")
                    wait_pending()
                    page.locator('.mini-queue-close').click()
                    fulfill(pending.pop(), {"items": [item("hold")]})
                    complete()
                    assert not page.locator('#queue-panel').evaluate("node => node.classList.contains('show')")
                    page.locator('[data-action="queue"]').click()
                    assert page.locator('.playlist-library').is_visible()
                    assert page.locator('.playlist-card-import:disabled').count() == 0
                    assert not unexpected_writes
                    assert len(writes) == 7
                    checks.append("closed-panel-stays-closed-and-reopens-at-library")
                    context_data = page.evaluate("JSON.parse(localStorage.getItem('minerats-playlists-v2'))")
                    assert len(context_data) == 4
                    checks.append("existing-local-storage-format-preserved")
                    profiles.append({"profile": name, "ok": True, "checks": checks, "mocked_queue_requests": len(writes), "real_queue_requests": 0})
                except Exception as exc:
                    page.screenshot(path=str(artifact_dir / f"playlist-{name}-failure.png"))
                    profiles.append({"profile": name, "ok": False, "checks": checks, "error": str(exc)})
                finally:
                    context.close()
        finally:
            browser.close()
    return {"ok": all(profile["ok"] for profile in profiles), "isolated_mock_writes": True, "profiles": profiles}


def main():
    if __package__:
        from .ci_browser_smoke import fixture_server
    else:
        from ci_browser_smoke import fixture_server
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[1] / "web/dist")
    parser.add_argument("--report", type=Path, default=Path("artifacts/playlist-browser/report.json"))
    args = parser.parse_args()
    with fixture_server(args.dist.resolve()) as base_url:
        report = run_playlist_checks(base_url, args.report.parent)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
