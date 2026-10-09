import asyncio
import json
import unittest

from backend.ws_manager import WsManager


class _Socket:
    def __init__(self, *, blocked=False, broken=False):
        self.sent = []
        self.closed = []
        self.started = asyncio.Event()
        self.delivered = asyncio.Event()
        self.release = asyncio.Event()
        self.broken = broken
        if not blocked:
            self.release.set()

    async def accept(self, *, subprotocol=None):
        self.subprotocol = subprotocol

    async def send_text(self, payload):
        self.started.set()
        await self.release.wait()
        if self.broken:
            raise ConnectionError("closed")
        self.sent.append(payload)
        self.delivered.set()

    async def close(self, *, code):
        self.closed.append(code)


class WebSocketQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = WsManager(send_timeout=0.1, max_pending=4)

    async def asyncTearDown(self):
        await self.manager.close()

    async def test_slow_client_does_not_block_other_clients_and_is_pruned(self):
        slow, fast = _Socket(blocked=True), _Socket()
        await self.manager.connect(slow)
        await self.manager.connect(fast, subprotocol="minerats-v1")
        await asyncio.wait_for(self.manager.broadcast({"type": "started"}), 0.05)
        await asyncio.wait_for(fast.delivered.wait(), 0.05)
        self.assertEqual(json.loads(fast.sent[0])["type"], "started")
        self.assertEqual(fast.subprotocol, "minerats-v1")
        await asyncio.sleep(0.15)
        self.assertEqual(self.manager.active_count, 1)
        self.assertEqual(slow.closed, [1013])

    async def test_progress_is_coalesced_without_losing_state_events_or_pong(self):
        socket = _Socket(blocked=True)
        await self.manager.connect(socket)
        await self.manager.send_text(socket, "initial")
        await asyncio.wait_for(socket.started.wait(), 0.05)
        await self.manager.broadcast({"type": "started"})
        await self.manager.broadcast({"type": "progress", "position": 1})
        await self.manager.broadcast({"type": "finished"})
        for position in range(2, 102):
            await self.manager.broadcast({"type": "progress", "position": position})
        await self.manager.send_text(socket, '{"type":"pong"}')
        self.assertEqual(self.manager.active_count, 1)
        socket.release.set()
        for _ in range(100):
            if len(socket.sent) == 5:
                break
            await asyncio.sleep(0.001)
        self.assertEqual(socket.sent[0], "initial")
        self.assertEqual([json.loads(item)["type"] for item in socket.sent[1:]], ["started", "finished", "progress", "pong"])
        self.assertEqual(json.loads(socket.sent[3])["position"], 101)

    async def test_bounded_event_backlog_drops_only_overloaded_client(self):
        slow, fast = _Socket(blocked=True), _Socket()
        await self.manager.connect(slow)
        await self.manager.connect(fast)
        for number in range(5):
            await self.manager.send_text(slow, str(number))
        await self.manager.send_text(fast, "still-responsive")
        await asyncio.wait_for(fast.delivered.wait(), 0.05)
        self.assertEqual(fast.sent, ["still-responsive"])
        self.assertEqual(self.manager.active_count, 1)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(slow.closed, [1013])

    async def test_broken_client_does_not_break_broadcast(self):
        socket = _Socket(broken=True)
        await self.manager.connect(socket)
        await self.manager.broadcast({"type": "started"})
        await asyncio.wait_for(socket.started.wait(), 0.05)
        for _ in range(20):
            if not self.manager.has_connections:
                break
            await asyncio.sleep(0.001)
        self.assertFalse(self.manager.has_connections)

    async def test_shutdown_awaits_all_sender_tasks_and_allows_restart(self):
        socket = _Socket(blocked=True)
        await self.manager.connect(socket)
        await self.manager.send_text(socket, "blocked")
        await asyncio.wait_for(socket.started.wait(), 0.05)
        writers = tuple(self.manager._writer_tasks)
        await self.manager.close()
        self.assertFalse(self.manager.has_connections)
        self.assertTrue(all(task.done() for task in writers))
        self.assertEqual(socket.closed, [1001])
        fresh = _Socket()
        await self.manager.connect(fresh)
        await self.manager.send_text(fresh, "restarted")
        await asyncio.wait_for(fresh.delivered.wait(), 0.05)
        self.assertEqual(fresh.sent, ["restarted"])

    async def test_disconnect_cancels_writer_without_closing_peer_twice(self):
        socket = _Socket()
        await self.manager.connect(socket)
        writer = next(iter(self.manager._writer_tasks))
        self.manager.disconnect(socket)
        await self.manager.close()
        self.assertTrue(writer.done())
        self.assertEqual(socket.closed, [])
