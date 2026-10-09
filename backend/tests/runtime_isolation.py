"""Configure disposable runtime paths before importing backend test targets.

Tests must never bootstrap passwords, logs, uploads or SQLite in the developer's
working tree. This helper is deliberately test-only and also supports unittest
discovery from the top-level ``tests`` directory.
"""
from __future__ import annotations

import atexit
import logging
import os
from pathlib import Path
import sys
import tempfile


_runtime: tempfile.TemporaryDirectory | None = None


def configure_test_runtime() -> Path:
    global _runtime
    if _runtime is not None:
        return Path(_runtime.name)
    _runtime = tempfile.TemporaryDirectory(prefix="minerats-tests-")
    root = Path(_runtime.name)
    values = {
        "DATABASE_URL": f"sqlite:///{(root / 'tsbot.db').as_posix()}",
        "TSBOT_DATABASE_URL": f"sqlite:///{(root / 'tsbot.db').as_posix()}",
        "TSBOT_LOG_FILE": str(root / "logs" / "backend.log"),
        "TSBOT_INITIAL_PASSWORD_FILE": str(root / "logs" / "initial-admin-password.txt"),
        "TSBOT_VOICE_CONFIG_FILE": str(root / "logs" / "voice-service.json"),
        "TSBOT_ASSET_DIR": str(root / "uploads"),
        "TSBOT_COOKIE_KEY": "isolated-test-cookie-key-at-least-32-characters",
        "TSBOT_API_TOKEN": "test-api-token",
        "TSBOT_API_TOKENS": "",
        "TSBOT_ADMIN_TOKEN": "test-admin-token",
        "TSBOT_INITIAL_ADMIN_PASSWORD": "isolated-test-password",
        "TSBOT_REQUIRE_API_AUTH": "true",
        "TSBOT_REQUIRE_ADMIN_AUTH": "true",
    }
    os.environ.update(values)

    def cleanup():
        module = sys.modules.get("backend.db")
        if module is not None:
            engine = getattr(module, "_engine", None)
            if engine is not None and str(engine.url) == values["DATABASE_URL"]:
                engine.dispose()
        loggers = [logging.getLogger()]
        loggers.extend(item for item in logging.Logger.manager.loggerDict.values() if isinstance(item, logging.Logger))
        for logger in loggers:
            for handler in tuple(logger.handlers):
                if isinstance(handler, logging.FileHandler) and Path(handler.baseFilename).is_relative_to(root):
                    logger.removeHandler(handler)
                    handler.close()
        _runtime.cleanup()

    atexit.register(cleanup)
    return root
