import asyncio
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import grpc

from backend.tests.runtime_isolation import configure_test_runtime

configure_test_runtime()

from backend.voice_client import VoiceClient
from backend.config import settings


class _Stream:
    def __init__(self):
        self.entered = asyncio.Event()
        self.cancelled = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.entered.set()
        await asyncio.Event().wait()

    def cancel(self):
        self.cancelled = True


class VoiceDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = VoiceClient()
        names = ("Ping", "Play", "Pause", "Resume", "Seek", "Stop", "Skip", "SendNotice", "SetClientDescription", "SetVolume", "GetStatus", "SetAudioFx", "GetAudioFx")
        self.stub = SimpleNamespace(**{name: AsyncMock() for name in names})
        self.client._stub = self.stub
        self.client._pb2 = SimpleNamespace(**{name: lambda **values: SimpleNamespace(**values) for name in ("Empty", "PlayRequest", "SeekRequest", "NoticeRequest", "SetClientDescriptionRequest", "SetVolumeRequest", "SetAudioFxRequest", "SubscribeRequest")})
        self.stub.Ping.return_value = SimpleNamespace(version="test")
        self.stub.Seek.return_value = SimpleNamespace(ok=True)
        self.stub.GetStatus.return_value = SimpleNamespace(State=SimpleNamespace(Name=lambda _: "STATE_PLAYING"), state=1, now_playing_title="song", now_playing_source_url="file://song", volume_percent=25)
        self.stub.GetAudioFx.return_value = SimpleNamespace(pan=0, width=1, swap_lr=False, bass_db=0, reverb_mix=0)

    async def test_every_unary_rpc_has_a_bounded_deadline(self):
        await self.client.ping()
        await self.client.play("file://song", "song", "tester")
        await self.client.pause()
        await self.client.resume()
        await self.client.seek(5)
        await self.client.stop()
        await self.client.skip()
        await self.client.send_notice("notice")
        await self.client.set_client_description("description")
        await self.client.set_volume(25)
        status = await self.client.get_status()
        await self.client.set_audio_fx(pan=0.2, bass_db=1)
        await self.client.get_audio_fx()
        self.assertEqual(status.volume_percent, 25)
        for name, method in vars(self.stub).items():
            with self.subTest(rpc=name):
                method.assert_awaited_once()
                self.assertEqual(method.await_args.kwargs["timeout"], self.client.STATUS_TIMEOUT if name in {"Ping", "GetStatus", "GetAudioFx"} else self.client.COMMAND_TIMEOUT)

    async def test_failed_stateful_rpc_is_not_retried(self):
        self.stub.Skip.side_effect = TimeoutError("deadline exceeded")
        with self.assertRaises(TimeoutError):
            await self.client.skip()
        self.stub.Skip.assert_awaited_once()

    async def test_real_grpc_deadline_releases_a_stalled_status_request(self):
        entered = asyncio.Event()

        async def stalled_status(request, context):
            entered.set()
            await asyncio.Event().wait()

        server = grpc.aio.server()
        server.add_generic_rpc_handlers((grpc.method_handlers_generic_handler(
            "tsbot.voice.v1.VoiceService",
            {"GetStatus": grpc.unary_unary_rpc_method_handler(stalled_status)},
        ),))
        port = server.add_insecure_port("127.0.0.1:0")
        await server.start()
        client = VoiceClient()
        client.STATUS_TIMEOUT = 0.15
        try:
            with patch.object(settings, "voice_grpc_addr", f"127.0.0.1:{port}"):
                started = time.monotonic()
                with self.assertRaises(grpc.aio.AioRpcError) as failure:
                    await client.get_status()
                self.assertTrue(entered.is_set())
                self.assertEqual(failure.exception.code(), grpc.StatusCode.DEADLINE_EXCEEDED)
                self.assertLess(time.monotonic() - started, 2.0)
        finally:
            await client.close()
            await server.stop(0)

    async def test_event_subscription_has_long_deadline_and_cancels_on_shutdown(self):
        stream = _Stream()
        self.stub.SubscribeEvents = Mock(return_value=stream)
        iterator = self.client.subscribe_events()
        task = asyncio.create_task(anext(iterator))
        await asyncio.wait_for(stream.entered.wait(), 0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stream.cancelled)
        self.assertEqual(self.stub.SubscribeEvents.call_args.kwargs["timeout"], self.client.EVENT_STREAM_TIMEOUT)

    async def test_close_resets_channel_and_stub_state(self):
        channel = SimpleNamespace(close=AsyncMock())
        self.client._channel = channel
        await self.client.close()
        channel.close.assert_awaited_once()
        self.assertIsNone(self.client._channel)
        self.assertIsNone(self.client._stub)
        self.assertIsNone(self.client._pb2)
