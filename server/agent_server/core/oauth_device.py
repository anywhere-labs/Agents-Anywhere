"""Device authorization grant (RFC 8628) domain values.

The OpenCode plug-in signs in with the loopback OAuth flow on a normal desktop,
but a headless or SSH session cannot reach a ``127.0.0.1`` callback.  The device
grant lets the plug-in show a short user code, the user approves it from an
already signed-in web session, and the plug-in polls for the access token.
"""

from __future__ import annotations

import hashlib
import secrets

# Crockford-style alphabet: no I, L, O or U, so a code stays easy to read and
# type.  ``normalize_user_code`` folds the remaining look-alikes (I, L, O) onto
# the canonical digits before validation, so a hand-typed code still matches.
USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
USER_CODE_LENGTH = 8
_CONFUSABLE = str.maketrans({"I": "1", "L": "1", "O": "0"})

# A short validity window keeps a leaked user code useless quickly; the attempt
# window bounds how many wrong codes one account may try at the web page.
DEVICE_CODE_TTL_SECONDS = 600
DEVICE_POLL_INTERVAL_SECONDS = 5
SLOW_DOWN_INCREMENT_SECONDS = 5
MAX_USER_CODE_ATTEMPTS = 10
USER_CODE_ATTEMPT_WINDOW_SECONDS = 900

DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

# RFC 8628 section 3.5 error codes returned by the token endpoint.  The strings
# are also the map from a flow state to the code the token endpoint reports.
DEVICE_ERRORS = {
    "authorization_pending": "authorization is pending",
    "slow_down": "polling too frequently",
    "access_denied": "the user denied the request",
    "expired_token": "device code expired",
    "invalid_grant": "invalid device code",
}

# Not an RFC 8628 token-endpoint state: the approval page reports a conflict
# when the user code it was handed has already been approved or denied.
DEVICE_APPROVAL_CONFLICT = "already_handled"
DEVICE_APPROVAL_CONFLICT_DESCRIPTION = "user code has already been approved or denied"


class OAuthDeviceFlowError(ValueError):
    """A device-grant failure that carries an RFC 8628 error code.

    ``code`` is safe to surface to the caller; the message never includes the
    device code, the user code or any other secret.
    """

    def __init__(self, code: str, description: str | None = None) -> None:
        resolved = description or DEVICE_ERRORS.get(code, code)
        super().__init__(resolved)
        self.code = code
        self.description = resolved


def generate_device_code() -> str:
    """Return a high-entropy device code (the polling secret)."""

    return secrets.token_urlsafe(32)


def generate_user_code() -> str:
    """Return a readable ``XXXX-XXXX`` user code for a new device request."""

    raw = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_user_code(value: str | None) -> str:
    """Return the canonical (upper, dash-less) code, or ``""`` when invalid.

    Accepts a code with or without the separator and in any case, mapping the
    ambiguous letters I, L and O onto 1 and 0.
    """

    if not value:
        return ""
    cleaned = value.strip().upper().translate(_CONFUSABLE)
    cleaned = "".join(char for char in cleaned if char.isalnum())
    if len(cleaned) != USER_CODE_LENGTH:
        return ""
    if any(char not in USER_CODE_ALPHABET for char in cleaned):
        return ""
    return cleaned


def hash_secret(value: str) -> str:
    """Hash a device or user code for at-rest storage."""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()
