"""First-run bootstrap token.

When the user table is empty, the server prints a one-shot setup token to its
stderr log. The bootstrap path of ``/auth/register`` requires that token, so
whoever can read the server log is the only one who can create the first
admin — closing the obvious public-deployment hole where the first visitor
silently claims the instance.

When the token expires, the next call to :meth:`SetupToken.snapshot` generates
a new one and re-prints it to the log. Restarting the server also discards
any in-memory token.
"""

from __future__ import annotations

import datetime as dt
import hmac
import os
import secrets
import sys
import threading
from typing import Callable


DEFAULT_TTL_SECONDS = 15 * 60
MIN_TTL_SECONDS = 60


def _read_ttl_from_env() -> int:
    raw = os.environ.get("AGENT_SERVER_SETUP_TOKEN_TTL")
    if not raw:
        return DEFAULT_TTL_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_TTL_SECONDS
    return max(MIN_TTL_SECONDS, value)


def _iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


class SetupToken:
    """Single in-memory bootstrap token with lazy auto-regeneration."""

    def __init__(
        self,
        *,
        ttl_seconds: int | None = None,
        log_writer: Callable[[str], None] | None = None,
        clock: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self._ttl = ttl_seconds if ttl_seconds is not None else _read_ttl_from_env()
        self._lock = threading.Lock()
        self._value: str | None = None
        self._expires_at: dt.datetime | None = None
        self._log = log_writer or _default_log
        self._now = clock or (lambda: dt.datetime.now(dt.UTC))

    @property
    def ttl_seconds(self) -> int:
        return self._ttl

    def snapshot(self) -> tuple[str, dt.datetime]:
        """Return the current valid (token, expires_at), regenerating on expiry."""
        with self._lock:
            self._ensure_fresh_locked()
            assert self._value is not None and self._expires_at is not None
            return self._value, self._expires_at

    def current_expires_at_iso(self) -> str:
        _, expires_at = self.snapshot()
        return _iso_utc(expires_at)

    def verify(self, candidate: str | None) -> bool:
        if not candidate:
            return False
        with self._lock:
            self._ensure_fresh_locked()
            current = self._value or ""
        return hmac.compare_digest(candidate.encode("utf-8"), current.encode("utf-8"))

    def consume(self) -> None:
        """Drop the token after a successful bootstrap so it cannot be reused."""
        with self._lock:
            self._value = None
            self._expires_at = None

    def peek(self) -> str | None:
        """Return the current token value without triggering (re)generation.

        Used by tests that want to capture the token after the server has
        already generated it (via lifespan or a /auth/config call).
        """
        with self._lock:
            return self._value

    def peek_state(self) -> tuple[str | None, dt.datetime | None]:
        """Return (value, expires_at) without side effects. For introspection."""
        with self._lock:
            return self._value, self._expires_at

    def _ensure_fresh_locked(self) -> None:
        now = self._now()
        if self._value is None or self._expires_at is None or self._expires_at <= now:
            self._value = _generate_token_value()
            self._expires_at = now + dt.timedelta(seconds=self._ttl)
            self._announce_locked()

    def _announce_locked(self) -> None:
        assert self._value is not None and self._expires_at is not None
        minutes = max(1, self._ttl // 60)
        banner = (
            "\n"
            "============================================================\n"
            "  AGENT SERVER  ·  first-run setup required\n"
            "\n"
            "  Paste this token into the setup page to create the admin:\n"
            "\n"
            f"    setup-token: {self._value}\n"
            "\n"
            f"  Expires at:  {_iso_utc(self._expires_at)}  (in ~{minutes} min)\n"
            "  Expired? A new token is generated automatically — re-check this log.\n"
            "============================================================\n"
        )
        try:
            self._log(banner)
        except Exception:
            # Logging must never break the request path.
            pass


def _generate_token_value() -> str:
    # 18 bytes → 24 url-safe chars. Long enough to be unguessable, short enough
    # to copy from a terminal in one go.
    return secrets.token_urlsafe(18)


def _default_log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
