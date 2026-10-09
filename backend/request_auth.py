"""HTTP/WebSocket request token policy, separate from playback orchestration.

This is the existing request contract, including explicitly configured legacy
compatibility mode. It does not change administrator session authentication.
"""
from __future__ import annotations

from collections.abc import Callable
import hmac

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse

from .auth_contracts import WEBSOCKET_PROTOCOL, extract_websocket_protocol_token
from .config import settings


def normalize_request_path(path: str) -> str:
    normalized = (path or "/").rstrip("/")
    return normalized or "/"


def get_request_api_token(request: Request) -> str:
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-api-token") or "").strip()


def get_websocket_api_token(websocket: WebSocket) -> str:
    auth = (websocket.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    header_token = (websocket.headers.get("x-api-token") or "").strip()
    if header_token:
        return header_token
    return extract_websocket_protocol_token(websocket.headers.get("sec-websocket-protocol"))


def websocket_subprotocol(websocket: WebSocket) -> str | None:
    protocols = {
        part.strip()
        for part in (websocket.headers.get("sec-websocket-protocol") or "").split(",")
        if part.strip()
    }
    return WEBSOCKET_PROTOCOL if WEBSOCKET_PROTOCOL in protocols else None


def path_requires_api_token(path: str) -> bool:
    if not settings.require_api_auth and not settings.get_api_tokens():
        return False
    normalized = normalize_request_path(path)
    if normalized in {"/", "/docs", "/redoc", "/openapi.json", "/config/public", "/health/live", "/health/ready"}:
        return False
    if normalized.startswith(("/docs/", "/redoc/", "/auth/", "/admin/", "/assets/", "/cover/")):
        return False
    return normalized != "/admin"


def check_api_token(request: Request) -> str | None:
    tokens = settings.get_api_tokens()
    if not tokens:
        return "api token authentication is required but no token is configured"
    provided = get_request_api_token(request)
    if not provided:
        return "missing api token"
    if any(hmac.compare_digest(provided, token) for token in tokens):
        return None
    return "invalid api token"


async def api_token_middleware(
    request: Request,
    call_next,
    *,
    path_requires: Callable[[str], bool] | None = None,
    token_check: Callable[[Request], str | None] | None = None,
):
    policy = path_requires if path_requires is not None else path_requires_api_token
    checker = token_check if token_check is not None else check_api_token
    if request.method == "OPTIONS" or not policy(request.url.path):
        return await call_next(request)
    error = checker(request)
    if error is not None:
        return JSONResponse(
            status_code=503 if "no token is configured" in error else 401,
            content={"detail": error},
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await call_next(request)
