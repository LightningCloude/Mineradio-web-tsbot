from __future__ import annotations

import base64

from cryptography.fernet import Fernet

from .config import settings


def _get_fernet() -> Fernet:
    key = settings.cookie_key.encode("utf-8")
    if len(key) == 44:
        try:
            return Fernet(key)
        except ValueError:
            # A passphrase can coincidentally be 44 bytes without being a
            # valid Fernet key. Such values never worked previously, so fall
            # through to the legacy passphrase derivation below.
            pass
    key = base64.urlsafe_b64encode(key.ljust(32, b"0")[:32])
    return Fernet(key)


def encrypt_text(value: str) -> str:
    f = _get_fernet()
    return f.encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_text(value: str) -> str:
    f = _get_fernet()
    return f.decrypt(value.encode("utf-8")).decode("utf-8")
