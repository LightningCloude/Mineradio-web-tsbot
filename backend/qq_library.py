"""Read-only shared QQ library. Each read owns a credential snapshot, never the player client."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import time

from .qqmusic import QQMusicClient


class LibraryError(Exception):
    def __init__(self, status: str):
        self.status = status


def check_response(value: dict) -> None:
    if not isinstance(value, dict):
        raise LibraryError("unavailable")
    codes = [value.get("code", 0), value.get("subcode", 0)]
    if any(str(code) in {"1000", "1001", "301"} for code in codes):
        raise LibraryError("expired")
    if any(str(code) != "0" for code in codes):
        raise LibraryError("unavailable")


def fingerprint(cookie: str, secret: str) -> tuple[str, str, QQMusicClient]:
    client = QQMusicClient()
    client.set_cookie(cookie)
    if not cookie:
        raise LibraryError("unconfigured")
    if not client.get_uin():
        raise LibraryError("expired")
    def digest(value):
        return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()
    return digest("account:" + client.get_uin())[:32], digest("version:" + cookie)[:32], client


def normalize_directory(raw: dict) -> dict | None:
    try:
        directory = int(raw.get("dirid", -1))
        identifier = str(raw.get("tid") or "")
        if not identifier.isdigit() or int(identifier) <= 0 or not (directory == 201 or 1 <= directory < 200):
            return None
        return {"id": identifier, "kind": "liked" if directory == 201 else "created",
                "name": "我喜欢的音乐" if directory == 201 else str(raw.get("diss_name") or "未命名歌单"),
                "cover": str(raw.get("diss_cover") or ""), "songCount": max(0, int(raw.get("song_cnt") or 0))}
    except (TypeError, ValueError):
        return None


class SharedQQLibrary:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self._cache = {}
        self._pending = {}

    async def close(self):
        tasks = list(self._pending.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._pending.clear()
        self._cache.clear()

    async def directory(self, cookie: str, secret: str, refresh: bool = False) -> dict:
        account, version, client = fingerprint(cookie, secret)
        cached = self._cache.get(version)
        # Merge visitors and repeated refresh clicks; no persistence of credentials.
        if cached and self.clock() - cached[0] < (5 if refresh else 60):
            return copy.deepcopy(cached[1])
        if version not in self._pending:
            self._pending[version] = asyncio.create_task(self._load(account, version, client))
            def completed(task):
                self._pending.pop(version, None)
                if not task.cancelled():
                    task.exception()  # Retrieve failures even if every HTTP reader disconnected.
            self._pending[version].add_done_callback(completed)
        return copy.deepcopy(await asyncio.shield(self._pending[version]))

    async def _load(self, account, version, client):
        items = []
        seen = set()
        total = None
        offset = 0
        async with asyncio.timeout(35):
            for _ in range(100):
                data = await client.get_user_playlists(offset, 200)
                check_response(data)
                body = data.get("data")
                if not isinstance(body, dict) or not isinstance(body.get("disslist"), list):
                    raise LibraryError("unavailable")
                page = body["disslist"]
                declared = body.get("totoal", body.get("total"))
                try:
                    if declared is not None:
                        total = max(0, int(declared))
                except (TypeError, ValueError):
                    raise LibraryError("unavailable")
                new = 0
                for raw in page:
                    item = normalize_directory(raw) if isinstance(raw, dict) else None
                    if item and item["id"] not in seen:
                        seen.add(item["id"]); items.append(item); new += 1
                offset += len(page)
                if not page or (total is not None and offset >= total) or (total is None and len(page) < 200):
                    complete = total is None or offset >= total
                    break
                if not new:
                    raise LibraryError("unavailable")
            else:
                complete = False
        items.sort(key=lambda item: item["kind"] != "liked")
        result = {"status": "ready", "account_id": account, "account_version": version,
                  "items": items, "complete": complete}
        self._cache = {version: (self.clock(), result)}
        return result

    async def detail(self, cookie: str, secret: str, identifier: str, expected_version: str) -> dict:
        account, version, client = fingerprint(cookie, secret)
        if not hmac.compare_digest(version, expected_version):
            raise LibraryError("account_changed")
        directory = await self.directory(cookie, secret)
        item = next((entry for entry in directory["items"] if entry["id"] == identifier), None)
        if not item:
            raise LibraryError("not_found")
        data = await client.get_song_list(identifier)
        check_response(data)
        if not isinstance(data.get("cdlist"), list) or not data["cdlist"]:
            raise LibraryError("unavailable")
        # Allowlisted raw fields needed by the established song adapter; no upstream credentials.
        raw = data["cdlist"][0]
        if not isinstance(raw, dict) or not isinstance(raw.get("songlist"), list):
            raise LibraryError("unavailable")
        fields = {"songmid", "mid", "songname", "name", "title", "singer", "album", "albummid", "albumname", "interval"}
        songs = [{key: value for key, value in song.items() if key in fields}
                 for song in raw["songlist"] if isinstance(song, dict)]
        return {"status": "ready", "account_id": account, "account_version": version,
                "playlist": item, "data": {"code": 0, "cdlist": [{"dissid": identifier,
                "dissname": item["name"], "logo": item["cover"], "total_song_num": max(item["songCount"], int(raw.get("total_song_num") or 0)),
                "songlist": songs}]}}
