"""Time-based one-time passwords (RFC 6238) and recovery codes.

Authenticator apps such as Google Authenticator, Microsoft Authenticator,
1Password or Aegis share one secret with the Server and show a six-digit code
that changes every 30 seconds. Recovery codes are single-use fallbacks for a
lost device; only their hashes are stored.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote, urlencode

TOTP_DIGITS = 6
TOTP_PERIOD_SECONDS = 30
# Accept the previous and next period so small clock drift still works.
TOTP_ALLOWED_DRIFT_STEPS = 1
SECRET_BYTES = 20
RECOVERY_CODE_COUNT = 10
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_RECOVERY_GROUP = 5


def generate_secret() -> str:
    """Return a new base32 secret without padding (what authenticator apps expect)."""
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii").rstrip("=")


def _secret_bytes(secret: str) -> bytes:
    normalized = secret.strip().replace(" ", "").upper()
    padding = "=" * (-len(normalized) % 8)
    return base64.b32decode(normalized + padding, casefold=True)


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // TOTP_PERIOD_SECONDS)


def code_at_step(secret: str, step: int) -> str:
    digest = hmac.new(_secret_bytes(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{value % (10**TOTP_DIGITS):0{TOTP_DIGITS}d}"


def normalize_code(code: str | None) -> str:
    return "".join(ch for ch in (code or "") if not ch.isspace() and ch != "-").lower()


def looks_like_totp_code(code: str | None) -> bool:
    normalized = normalize_code(code)
    return len(normalized) == TOTP_DIGITS and normalized.isdigit()


def matching_step(
    secret: str,
    code: str | None,
    *,
    now: float | None = None,
    after_step: int | None = None,
) -> int | None:
    """Return the period the code belongs to, or None.

    ``after_step`` is the last period already accepted for this secret. Codes
    from that period or earlier are rejected so an observed code cannot be
    replayed.
    """
    if not looks_like_totp_code(code):
        return None
    candidate = normalize_code(code)
    step = current_step(now)
    for offset in range(-TOTP_ALLOWED_DRIFT_STEPS, TOTP_ALLOWED_DRIFT_STEPS + 1):
        probe = step + offset
        if after_step is not None and probe <= after_step:
            continue
        if hmac.compare_digest(code_at_step(secret, probe), candidate):
            return probe
    return None


def provisioning_uri(secret: str, *, account: str, issuer: str) -> str:
    label = quote(f"{issuer}:{account}", safe="@:")
    query = urlencode(
        {
            "secret": secret,
            "issuer": issuer,
            "algorithm": "SHA1",
            "digits": TOTP_DIGITS,
            "period": TOTP_PERIOD_SECONDS,
        }
    )
    return f"otpauth://totp/{label}?{query}"


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    codes: list[str] = []
    for _ in range(count):
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(_RECOVERY_GROUP * 2))
        codes.append(f"{raw[:_RECOVERY_GROUP]}-{raw[_RECOVERY_GROUP:]}")
    return codes


def hash_recovery_code(code: str) -> str:
    return hashlib.sha256(normalize_code(code).encode("utf-8")).hexdigest()
