"""Destructive queue tests use only disposable SQLite and a mocked voice client."""
import asyncio
import json
import time
import tempfile
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend.tests.runtime_isolation import configure_test_runtime

configure_test_runtime()
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from backend import db, main, models
from backend.voice_client import VoiceStatus


class ClearQueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        db.Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.patches = [
            patch.object(main, "new_session", self.sessions),
            patch.object(main, "_playback_lock", asyncio.Lock()),
            patch.object(main, "_current_queue_item_id", None),
            patch.object(main, "_cleared_playing_item", None),
            patch.object(main, "_pending_queue_item_id", None),
            patch.object(main, "_current_source_url", ""),
            patch.object(main, "_play_started_at", None),
            patch.object(main, "_paused_at", None),
            patch.object(main, "_paused_total_s", 0),
            patch.object(main, "_current_duration_ms", 0),
            patch.object(main, "_current_artist", ""),
            patch.object(main, "_current_album", ""),
            patch.object(main, "_current_artwork_url", ""),
            patch.object(main, "_play_request_generation", 0),
            patch.object(main, "_shuffle_queue", []),
            patch.object(main, "_current_shuffle_index", -1),
            patch.object(main, "_shuffle_enabled", False),
            patch.object(main, "_repeat_mode", "none"),
            patch.object(main, "_schedule_ts_description_update", Mock()),
            patch.object(models, "_queue_id_floor", 0),
            patch.object(main.voice, "stop", AsyncMock()),
            patch.object(main.voice, "get_status", AsyncMock(return_value=VoiceStatus(
                state="STATE_PLAYING", now_playing_title="Current", now_playing_source_url="https://fixture/current", volume_percent=10))),
        ]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.engine.dispose()

    def seed(self, count):
        with self.sessions() as session:
            session.add_all([models.QueueItem(track_id=f"qqmusic:mid{index}", title="Current" if index == 1 else f"Song {index}",
                artist="Artist", album="Album", duration=180000, cover_url="https://fixture/cover", source_url="https://fixture/current")
                for index in range(1, count + 1)])
            session.commit()
            return list(session.execute(select(models.QueueItem.id)).scalars())

    async def start_current(self, item_id, paused=False):
        await main._set_now_playing_queue_item(item_id, "https://fixture/current", duration_ms=180000,
            artist="Artist", album="Album", artwork_url="https://fixture/cover")
        main._play_started_at = time.monotonic() - 50
        if paused: main._paused_at = time.monotonic()

    async def test_bulk_delete_one_transaction_for_empty_small_and_large_queues(self):
        timings = {}
        for count in (0, 1, 300, 1000):
            self.seed(count)
            statements = []
            commits = []
            def record(conn, cursor, statement, parameters, context, many): statements.append(statement)
            def commit(conn): commits.append(True)
            event.listen(self.engine, "before_cursor_execute", record)
            event.listen(self.engine, "commit", commit)
            started = time.perf_counter()
            try:
                with self.sessions() as session:
                    result = await main._clear_queue_internal(session, stop_playback=False)
            finally:
                event.remove(self.engine, "before_cursor_execute", record)
                event.remove(self.engine, "commit", commit)
            timings[count] = round((time.perf_counter() - started) * 1000, 3)
            self.assertEqual(result["removed_count"], count)
            self.assertEqual(sum(sql.upper().startswith("DELETE FROM QUEUE_ITEMS") for sql in statements), 1)
            self.assertEqual(len(commits), 1)
        main.voice.stop.assert_not_awaited()
        print("clear_queue_isolated_ms=" + json.dumps(timings))

    async def test_playing_and_paused_state_progress_metadata_and_lyrics_survive(self):
        for paused in (False, True):
            item_id = self.seed(1)[0]
            await self.start_current(item_id, paused)
            before = await main.voice_status()
            clocks = (main._play_started_at, main._paused_at, main._paused_total_s)
            with self.sessions() as session:
                result = await main._clear_queue_internal(session, stop_playback=False)
                self.assertEqual(main.get_queue(session), [])
            after = await main.voice_status()
            self.assertEqual(clocks, (main._play_started_at, main._paused_at, main._paused_total_s))
            self.assertEqual(after["track_id"], item_id)
            self.assertEqual(after["state"], before["state"])
            self.assertAlmostEqual(after["current_time"], before["current_time"], delta=.1)
            for key in ("duration", "now_playing_artist", "now_playing_album", "artwork_url"):
                self.assertEqual(after[key], before[key])
            with patch.object(main.qqmusic, "get_song_lyric", AsyncMock(return_value={"lyric": "[00:01]still here"})), patch.object(main, "_get_admin_qqmusic_cookie", return_value="fixture"):
                lyrics = await main.lyrics(item_id)
            self.assertEqual(lyrics.lyrics[0].text, "still here")
            self.assertFalse(result["playback_stopped"])
        main.voice.stop.assert_not_awaited()

    async def test_cleared_track_cannot_repeat_and_new_songs_keep_unique_ids(self):
        for mode in ("none", "one", "all"):
            for shuffle in (False, True):
                with self.subTest(mode=mode, shuffle=shuffle):
                    with self.sessions() as session:
                        session.query(models.QueueItem).delete(); session.commit()
                    old_ids = self.seed(3)
                    await self.start_current(old_ids[-1])
                    main._repeat_mode = mode; main._shuffle_enabled = shuffle
                    main._shuffle_queue = old_ids.copy(); main._current_shuffle_index = 2
                    generation = await main._begin_play_request(old_ids[0])
                    with self.sessions() as session: await main._clear_queue_internal(session, stop_playback=False)
                    self.assertFalse(await main._is_play_request_current(generation))
                    self.assertIsNone(main._pending_queue_item_id)
                    self.assertEqual(main._shuffle_queue, [])
                    new_id = self.seed(1)[0]
                    self.assertGreater(new_id, max(old_ids))
                    with patch.object(main, "_play_queue_item_internal", AsyncMock(return_value=True)) as play:
                        await main._handle_playback_finished("https://fixture/current")
                        play.assert_awaited_once_with(new_id, requested_by="auto")
                    with self.sessions() as session: self.assertIsNotNone(session.get(models.QueueItem, new_id))

    async def test_empty_queue_naturally_finishes_even_in_repeat_one(self):
        item_id = self.seed(1)[0]
        await self.start_current(item_id)
        main._repeat_mode = "one"
        with self.sessions() as session: await main._clear_queue_internal(session, stop_playback=False)
        with patch.object(main, "_play_queue_item_internal", AsyncMock()) as play:
            await main._handle_playback_finished("https://fixture/current")
            play.assert_not_awaited()
        self.assertIsNone(main._current_queue_item_id)

    async def test_failed_transaction_preserves_state_and_does_not_stop_voice(self):
        item_id = self.seed(1)[0]
        await self.start_current(item_id)
        with self.sessions() as session, patch.object(session, "commit", side_effect=RuntimeError("write failed")):
            with self.assertRaises(RuntimeError): await main._clear_queue_internal(session, stop_playback=False)
        self.assertIsNone(main._cleared_playing_item)
        self.assertEqual(main._current_queue_item_id, item_id)
        main.voice.stop.assert_not_awaited()
        with self.sessions() as session: self.assertIsNotNone(session.get(models.QueueItem, item_id))

    async def test_routes_preserve_default_stop_and_explicit_keep_playing(self):
        def override_session():
            with self.sessions() as session: yield session
        main.app.dependency_overrides[main.get_session] = override_session
        try:
            client = TestClient(main.app, raise_server_exceptions=True)
            try:
                self.seed(1)
                response = client.delete("/external/queue?stop_playback=false", headers={"Authorization": "Bearer test-api-token"})
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.json()["playback_stopped"])
                main.voice.stop.assert_not_awaited()
                self.seed(1)
                response = client.delete("/external/queue", headers={"Authorization": "Bearer test-api-token"})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["playback_stopped"])
                main.voice.stop.assert_awaited_once()
            finally:
                client.close()
        finally:
            main.app.dependency_overrides.pop(main.get_session, None)

    async def test_release_checkpoint_restores_paused_metadata_without_audio_commands(self):
        item_id = self.seed(1)[0]
        main.voice.get_status.return_value.state = "STATE_PAUSED"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "checkpoint.json"
            path.write_text(json.dumps({"captured_at": time.time(), "state": "paused", "track_id": item_id,
                "current_time": 42.25, "now_playing_source_url": "https://fixture/current", "repeat_mode": "one"}), encoding="utf-8")
            with patch.dict(main.os.environ, {"TSBOT_RELEASE_PLAYBACK_CHECKPOINT": str(path)}):
                self.assertTrue(await main._restore_release_playback())
                status = await main.voice_status()
                self.assertEqual(status["state"], "paused")
                self.assertAlmostEqual(status["current_time"], 42.25, places=4)
                self.assertEqual(status["repeat_mode"], "one")
                self.assertEqual(status["track_id"], item_id)
                self.assertFalse(path.exists())
                self.assertFalse(await main._restore_release_playback())
        main.voice.stop.assert_not_awaited()

    async def test_release_checkpoint_rejects_stale_or_different_audio(self):
        item_id = self.seed(1)[0]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "checkpoint.json"
            for age, source in ((121, "https://fixture/current"), (0, "https://fixture/other")):
                path.write_text(json.dumps({"captured_at": time.time() - age, "state": "playing", "track_id": item_id,
                    "current_time": 42, "now_playing_source_url": source}), encoding="utf-8")
                with patch.dict(main.os.environ, {"TSBOT_RELEASE_PLAYBACK_CHECKPOINT": str(path)}):
                    self.assertFalse(await main._restore_release_playback())
                self.assertFalse(path.exists()); self.assertIsNone(main._current_queue_item_id)


if __name__ == "__main__": unittest.main()
