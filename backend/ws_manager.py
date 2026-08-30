"""
WebSocket connection manager for broadcasting playback state to web clients.
Uses time-based position tracking since gRPC PlaybackEvent has no position field.
"""
from fastapi import WebSocket
from typing import List
import asyncio
import json


class WsManager:
    def __init__(self):
        self._connections: List[WebSocket] = []

    async def connect(self, ws: WebSocket, subprotocol: str | None = None):
        await ws.accept(subprotocol=subprotocol)
        self._connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self._connections:
            self._connections.remove(ws)

    async def broadcast(self, message: dict):
        payload = json.dumps(message, ensure_ascii=False)
        dead = []
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    @property
    def active_count(self):
        return len(self._connections)

    @property
    def has_connections(self):
        return len(self._connections) > 0


ws_manager = WsManager()
