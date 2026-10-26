"""Read-only release acceptance for the shared QQ library; every HTTP write is blocked."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


def run(base_url, artifacts):
    artifacts = Path(artifacts); artifacts.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for mobile in (False, True):
                name = 'mobile' if mobile else 'desktop'
                context = browser.new_context(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900}, is_mobile=mobile, has_touch=mobile)
                page = context.new_page(); page.set_default_timeout(45000)
                writes = []; errors = []; paths = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                def protect(route):
                    request = route.request
                    if request.method not in {'GET', 'HEAD'}:
                        writes.append((request.method, urlparse(request.url).path)); route.abort('blockedbyclient')
                    else:
                        paths.append(urlparse(request.url).path); route.continue_()
                page.route('**/api/**', protect)
                try:
                    page.goto(base_url, wait_until='domcontentloaded')
                    reminder = page.locator('#audio-permission-reminder')
                    if reminder.count() and reminder.is_visible(): reminder.locator('[data-audio-permission="dismiss"]').click()
                    page.locator('[data-action="queue"]').click()
                    page.locator('[data-qq-id]').first.wait_for()
                    count = page.locator('[data-qq-id]').count()
                    assert count > 0
                    bounds = page.locator('#queue-panel').bounding_box()
                    assert bounds['x'] >= 0 and bounds['y'] >= 0
                    assert bounds['x'] + bounds['width'] <= page.viewport_size['width'] + 1
                    assert bounds['y'] + bounds['height'] <= page.viewport_size['height'] + 1
                    page.screenshot(path=str(artifacts / f'{name}-library.png'))
                    page.get_by_role('button', name='查看共享歌单：我喜欢的音乐', exact=True).click()
                    expect(page.locator('.qq-library-summary')).to_be_visible()
                    expect(page.locator('.qq-library-track')).to_have_count(50)
                    expect(page.locator('[data-qq-action="append"]')).to_be_enabled()
                    page.screenshot(path=str(artifacts / f'{name}-liked.png'))
                    page.locator('.mini-queue-back').click()
                    expect(page.locator('[data-qq-id]')).to_have_count(count)
                    assert not writes and not errors
                    assert not any('/audio' in path or '/download' in path for path in paths), paths
                    reports.append({'profile': name, 'ok': True, 'directory_count': count,
                        'checks': ['shared directory visible', 'viewport fit', 'liked detail loaded on demand', 'return navigation', 'no writes or audio downloads', 'no page errors'],
                        'writes_blocked': len(writes), 'page_errors': errors})
                finally: context.close()
        finally: browser.close()
    return {'ok': all(result['ok'] for result in reports), 'read_only': True, 'profiles': reports}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    result = run(args.base_url, args.artifacts)
    (args.artifacts / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
