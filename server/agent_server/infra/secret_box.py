"""Encrypt secrets the Server keeps: OAuth refresh tokens, manually entered
API keys and the model connection a runtime had before it was changed.

The key is derived from ``AGENT_SERVER_SECRET`` with HKDF, so a database
backup alone reveals none of them. A missing, default or short secret would
make that encryption meaningless, so the box refuses to work instead.
"""

from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

DEFAULT_SECRET = "agent-server-dev-secret"
MIN_SECRET_LENGTH = 32
_PREFIX = "v1:"
_INFO = b"agents-anywhere secret box v1"


class SecretBoxUnavailableError(RuntimeError):
    code = "secret_unconfigured"

    def __init__(self) -> None:
        super().__init__(
            "AGENT_SERVER_SECRET must be set to at least 32 characters before "
            "the Server can keep keys or link accounts"
        )


def secret_box_available(secret: str | None = None) -> bool:
    value = os.environ.get("AGENT_SERVER_SECRET", "") if secret is None else secret
    return len(value) >= MIN_SECRET_LENGTH and value != DEFAULT_SECRET


class SecretBox:
    def __init__(self, secret: str | None = None) -> None:
        value = os.environ.get("AGENT_SERVER_SECRET", "") if secret is None else secret
        if not secret_box_available(value):
            raise SecretBoxUnavailableError()
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=_INFO,
        ).derive(value.encode("utf-8"))
        self._aead = AESGCM(key)

    def seal(self, plaintext: str, *, context: str) -> str:
        """Encrypt ``plaintext``; ``context`` binds it to where it is stored."""
        nonce = os.urandom(12)
        sealed = self._aead.encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
        return _PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii")

    def open(self, ciphertext: str, *, context: str) -> str | None:
        """Decrypt, or None when the secret changed or the value was moved."""
        if not ciphertext.startswith(_PREFIX):
            return None
        try:
            raw = base64.urlsafe_b64decode(ciphertext[len(_PREFIX):].encode("ascii"))
            plaintext = self._aead.decrypt(raw[:12], raw[12:], context.encode("utf-8"))
        except (InvalidTag, ValueError):
            return None
        return plaintext.decode("utf-8")
