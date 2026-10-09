"""Bounded, independently drained WebSocket playback notification queues."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
import json

from fastapi import WebSocket


@dataclass
class _Connection:
    pending: deque[tuple[str, bool]] = field(default_factory=deque)
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    writer: asyncio.Task | None = None


class WsManager:
    def __init__(self, *, send_timeout: float = 5.0, max_pending: int = 32):
        if send_timeout <= 0 or max_pending < 1:
            raise ValueError("positive send_timeout and max_pending are required")
        self._send_timeout = send_timeout
        self._max_pending = max_pending
        self._connections: dict[WebSocket, _Connection] = {}
        self._writer_tasks: set[asyncio.Task] = set()
        self._closing_tasks: set[asyncio.Task] = set()

    async def connect(self, ws: WebSocket, subprotocol: str | None = None):
        if ws in self._connections:
            return
        await asyncio.wait_for(ws.accept(subprotocol=subprotocol), self._send_timeout)
        connection = _Connection()
        self._connections[ws] = connection
        connection.writer = asyncio.create_task(self._drain(ws, connection))
        self._writer_tasks.add(connection.writer)
        connection.writer.add_done_callback(self._writer_tasks.discard)

    def disconnect(self, ws: WebSocket):
        connection = self._connections.pop(ws, None)
        if connection is not None:
            connection.pending.clear()
            if connection.writer is not None and connection.writer is not asyncio.current_task():
                connection.writer.cancel()

    async def _close_socket(self, ws: WebSocket, code: int):
        try:
            await asyncio.wait_for(ws.close(code=code), self._send_timeout)
        except Exception:
            pass  # The peer may already have closed its side of the connection.

    def _drop_slow_client(self, ws: WebSocket):
        self.disconnect(ws)
        task = asyncio.create_task(self._close_socket(ws, 1013))
        self._closing_tasks.add(task)
        task.add_done_callback(self._closing_tasks.discard)

    def _enqueue(self, ws: WebSocket, payload: str, *, progress: bool = False):
        connection = self._connections.get(ws)
        if connection is None:
            return
        if progress:
            # Obsolete positions are replaceable; state changes and replies are not.
            connection.pending = deque(item for item in connection.pending if not item[1])
        if len(connection.pending) >= self._max_pending:
            self._drop_slow_client(ws)
            return
        connection.pending.append((payload, progress))
        connection.ready.set()

    async def _drain(self, ws: WebSocket, connection: _Connection):
        try:
            while True:
                await connection.ready.wait()
                while connection.pending:
                    payload, _ = connection.pending.popleft()
                    await asyncio.wait_for(ws.send_text(payload), self._send_timeout)
                connection.ready.clear()
        except asyncio.CancelledError:
            raise
        except Exception:
            if self._connections.get(ws) is connection:
                self._connections.pop(ws, None)
                await self._close_socket(ws, 1013)
        finally:
            connection.pending.clear()
            if self._connections.get(ws) is connection:
                self._connections.pop(ws, None)

    async def send_text(self, ws: WebSocket, payload: str):
        """Queue a direct reply through the same writer as broadcast messages."""
        self._enqueue(ws, payload)

    async def broadcast(self, message: dict):
        payload = json.dumps(message, ensure_ascii=False)
        for ws in tuple(self._connections):
            self._enqueue(ws, payload, progress=message.get("type") == "progress")

    async def close(self):
        """Await sender cancellation and bounded socket closes on app shutdown."""
        connections = tuple(self._connections.items())
        writers = tuple(self._writer_tasks)
        for ws, _ in connections:
            self.disconnect(ws)
        for writer in writers:
            writer.cancel()
        if writers:
            await asyncio.gather(*writers, return_exceptions=True)
        await asyncio.gather(
            *(self._close_socket(ws, 1001) for ws, _ in connections),
            *tuple(self._closing_tasks),
            return_exceptions=True,
        )

    @property
    def active_count(self):
        return len(self._connections)

    @property
    def has_connections(self):
        return bool(self._connections)


ws_manager = WsManager()
