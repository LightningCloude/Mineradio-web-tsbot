import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from backend.qq_library import SharedQQLibrary, LibraryError, fingerprint, normalize_directory
from backend.qqmusic import QQMusicClient


COOKIE = "uin=o123456; qm_keyst=fixture-only"
SECRET = "fixture-secret"


def row(identifier="99", directory=1, count=2):
    return {"tid": identifier, "dirid": directory, "diss_name": "fixture", "song_cnt": count, "dir_show": 0}


def response(rows, total=None):
    return {"code": 0, "subcode": 0, "data": {"disslist": rows, "totoal": len(rows) if total is None else total}}


class SharedLibraryTests(unittest.IsolatedAsyncioTestCase):
    def test_system_entries_filtered_and_private_owned_preserved(self):
        self.assertIsNone(normalize_directory(row(directory=205)))
        self.assertIsNone(normalize_directory(row(identifier="0")))
        self.assertIsNone(normalize_directory(row(identifier="oops")))
        self.assertEqual(normalize_directory(row(directory=201))["kind"], "liked")
        self.assertEqual(normalize_directory(row(directory=7))["id"], "99")

    def test_identity_is_opaque_account_stable_and_credential_versioned(self):
        account, version, client = fingerprint(COOKIE, SECRET)
        other_account, other_version, _ = fingerprint(COOKIE + "x", SECRET)
        self.assertEqual(account, other_account)
        self.assertNotEqual(version, other_version)
        self.assertNotIn("123456", account)
        self.assertEqual(client.get_uin(), "123456")

    async def test_paginated_directory_deduplicated_liked_first_and_no_detail_prefetch(self):
        service = SharedQQLibrary()
        pages = [response([row("2"), row("3", 201)], 3), response([row("2")], 3)]
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(side_effect=pages)) as read, patch.object(QQMusicClient, "get_song_list", AsyncMock()) as details:
            result = await service.directory(COOKIE, SECRET)
        self.assertEqual([item["id"] for item in result["items"]], ["3", "2"])
        self.assertTrue(result["complete"])
        self.assertEqual(read.await_args_list[1].args, (2, 200))
        details.assert_not_awaited()

    async def test_concurrent_reads_merge_and_cached_results_are_copies(self):
        service = SharedQQLibrary()
        async def read(*args):
            await asyncio.sleep(.01)
            return response([row()])
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(side_effect=read)) as get:
            first, second = await asyncio.gather(service.directory(COOKIE, SECRET), service.directory(COOKIE, SECRET))
            first["items"].clear()
            third = await service.directory(COOKIE, SECRET, refresh=True)
        self.assertEqual(get.await_count, 1)
        self.assertEqual(len(second["items"]), 1)
        self.assertEqual(len(third["items"]), 1)

    async def test_refresh_and_changed_cookie_do_not_share_wrong_snapshot(self):
        now = [0]
        service = SharedQQLibrary(clock=lambda: now[0])
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(return_value=response([]))) as read:
            await service.directory(COOKIE, SECRET)
            now[0] = 6
            await service.directory(COOKIE, SECRET, True)
            await service.directory("uin=5678; qm_keyst=another-fixture", SECRET)
        self.assertEqual(read.await_count, 3)

    async def test_unconfigured_expired_and_upstream_failure_not_empty_success(self):
        for cookie, expected in [("", "unconfigured"), ("qm_keyst=fixture", "expired")]:
            with self.assertRaises(LibraryError) as error:
                await SharedQQLibrary().directory(cookie, SECRET)
            self.assertEqual(error.exception.status, expected)
        for data, expected in [({"code": 1000}, "expired"), ({"code": 500}, "unavailable"), ({"code": 0}, "unavailable")]:
            with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(return_value=data)):
                with self.assertRaises(LibraryError) as error:
                    await SharedQQLibrary().directory(COOKIE, SECRET)
            self.assertEqual(error.exception.status, expected)

    async def test_detail_checks_account_and_membership_before_upstream(self):
        service = SharedQQLibrary()
        _, version, _ = fingerprint(COOKIE, SECRET)
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(return_value=response([row()]))), patch.object(QQMusicClient, "get_song_list", AsyncMock()) as read:
            for identifier, expected_version, status in [("99", "0" * 32, "account_changed"), ("100", version, "not_found")]:
                with self.assertRaises(LibraryError) as error:
                    await service.detail(COOKIE, SECRET, identifier, expected_version)
                self.assertEqual(error.exception.status, status)
            read.assert_not_awaited()

    async def test_detail_preserves_exact_mid_partial_count_and_omits_other_fields(self):
        service = SharedQQLibrary()
        _, version, _ = fingerprint(COOKIE, SECRET)
        data = {"code": 0, "cdlist": [{"songlist": [{"songmid": "ExactVersion", "songname": "Fixture", "interval": 123, "cookie": "MUST_NOT_RETURN"}]}]}
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(return_value=response([row(count=8)]))), patch.object(QQMusicClient, "get_song_list", AsyncMock(return_value=data)):
            result = await service.detail(COOKIE, SECRET, "99", version)
        detail = result["data"]["cdlist"][0]
        self.assertEqual(detail["total_song_num"], 8)
        self.assertEqual(detail["songlist"][0]["songmid"], "ExactVersion")
        self.assertNotIn("cookie", detail["songlist"][0])

    async def test_repeating_upstream_page_fails_instead_of_endless_pagination(self):
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(return_value=response([row()], 1000))) as read:
            with self.assertRaises(LibraryError):
                await SharedQQLibrary().directory(COOKIE, SECRET)
        self.assertEqual(read.await_count, 2)

    async def test_shutdown_cancels_pending_provider_reads_and_clears_metadata(self):
        service = SharedQQLibrary()
        started = asyncio.Event()
        async def stalled(*args):
            started.set()
            await asyncio.Event().wait()
        with patch.object(QQMusicClient, "get_user_playlists", AsyncMock(side_effect=stalled)):
            reader = asyncio.create_task(service.directory(COOKIE, SECRET))
            await started.wait()
            await service.close()
            with self.assertRaises(asyncio.CancelledError):
                await reader
        self.assertFalse(service._pending)
        self.assertFalse(service._cache)
