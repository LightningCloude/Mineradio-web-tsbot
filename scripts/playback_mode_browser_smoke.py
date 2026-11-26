"""Test mode selection against intercepted loopback routes, never a live queue."""
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


def run_mode_checks(origin: str, artifacts: Path) -> dict:
    if urlparse(origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Mode write fixtures require loopback")
    artifacts.mkdir(parents=True, exist_ok=True)
    profiles = []
    with sync_playwright() as playwright:
        with playwright.chromium.launch() as browser:
            for profile, width, height in (("desktop", 1440, 900), ("mobile", 390, 844)):
                with browser.new_context(viewport={"width": width, "height": height}, has_touch=profile == "mobile") as context:
                    page = context.new_page()
                    page.set_default_timeout(20000)
                    errors, writes, sockets = [], [], []
                    mode, fail = ["order"], [False]
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    def route_api(route):
                        request = route.request
                        path = urlparse(request.url).path
                        if path == "/api/external/player/mode" and request.method == "POST":
                            selected = request.post_data_json["mode"]
                            writes.append((path, selected))
                            if fail[0]:
                                route.fulfill(status=503, json={"detail": "fixture unavailable"})
                            else:
                                mode[0] = selected
                                route.fulfill(json={"ok": True, "playback_mode": selected})
                        elif path == "/api/external/status" and request.method == "GET":
                            route.fulfill(json={"state": "idle", "playback_mode": mode[0]})
                        elif request.method in ("GET", "HEAD"):
                            route.continue_()
                        else:
                            writes.append((path, "unexpected"))
                            route.abort("blockedbyclient")

                    page.route("**/api/**", route_api)
                    page.route_web_socket("**/ws/status", lambda ws: sockets.append(ws))
                    page.goto(origin, wait_until="networkidle")
                    reminder = page.locator('[data-audio-permission="dismiss"]')
                    if reminder.is_visible():
                        reminder.click()
                    trigger = page.locator('[data-action="playback-mode"]')
                    dialog = page.locator('#playback-mode-dialog')
                    expect(trigger).to_have_attribute("data-mode", "order")
                    trigger.focus()
                    page.keyboard.press("Space")
                    expect(dialog).to_be_visible()
                    expect(dialog.locator('[data-mode="order"]')).to_be_focused()
                    expect(dialog.locator('[data-mode="order"]')).to_contain_text("播完停止")
                    bounds = dialog.bounding_box()
                    assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= width + 1
                    page.screenshot(path=str(artifacts / f"{profile}-playback-mode.png"))
                    page.keyboard.press("Escape")
                    expect(dialog).to_be_hidden()
                    expect(trigger).to_be_focused()
                    assert not writes
                    for selection in ("repeat_one", "shuffle", "repeat_all", "order"):
                        trigger.click()
                        dialog.locator(f'[data-mode="{selection}"]').click()
                        expect(dialog).to_be_hidden()
                        expect(trigger).to_have_attribute("data-mode", selection)
                    assert [selected for _, selected in writes] == ["repeat_one", "shuffle", "repeat_all", "order"]
                    sockets[-1].send('{"type":"progress","state":"idle","position":0,"playback_mode":"shuffle"}')
                    expect(trigger).to_have_attribute("data-mode", "shuffle")
                    fail[0] = True
                    trigger.click()
                    dialog.locator('[data-mode="repeat_all"]').click()
                    expect(dialog.locator('[role="status"]')).to_contain_text("未能确认")
                    expect(dialog.locator('[data-mode="shuffle"]')).to_have_attribute("aria-pressed", "true")
                    assert len(writes) == 5 and all(path == "/api/external/player/mode" for path, _ in writes)
                    assert not errors, errors
                    profiles.append({"profile": profile, "ok": True, "checks": ["default stops and Space opens", "dialog fits and Escape restores focus", "all four options use one API request", "server events synchronize", "failed request keeps confirmed mode", "no unexpected writes or exceptions"]})
    return {"ok": True, "profiles": profiles}
