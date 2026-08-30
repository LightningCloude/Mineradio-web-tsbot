from __future__ import annotations

import base64


WEBSOCKET_PROTOCOL = "minerats-v1"
WEBSOCKET_TOKEN_PREFIX = "minerats-token."


def build_websocket_token_protocol(token: str) -> str:
    encoded = base64.urlsafe_b64encode(token.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{WEBSOCKET_TOKEN_PREFIX}{encoded}"


def extract_websocket_protocol_token(protocol_header: str | None) -> str:
    protocols = [part.strip() for part in (protocol_header or "").split(",")]
    encoded = next(
        (
            protocol.removeprefix(WEBSOCKET_TOKEN_PREFIX)
            for protocol in protocols
            if protocol.startswith(WEBSOCKET_TOKEN_PREFIX)
        ),
        "",
    )
    if not encoded:
        return ""

    try:
        padding = "=" * (-len(encoded) % 4)
        return base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return ""
