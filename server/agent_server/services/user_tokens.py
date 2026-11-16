"""Revocable logins (``05-server.md`` §8).

v2 user tokens were stateless for 7 days: logging out did nothing and a disabled
account kept working on most endpoints. Now every login opens a *token family*:

- the access token carries the family id (``fam``);
- a refresh token (``aart_<familyId>.<secret>``) rotates on every use; the Server
  keeps only hashes of the current and the previous one. Presenting the previous
  one again means it was copied, and the whole family is revoked;
- logout revokes the caller's family, a password change revokes the others,
  disabling an account revokes all of them;
- every authenticated request checks that the account is active and the family
  is not revoked. The answer is cached per worker for a few seconds, so a
  revocation reaches every worker within ``STATUS_CACHE_SECONDS``.

Access tokens keep their 7-day lifetime until clients refresh on their own; the
check above is what makes them revocable today. Tokens issued before the upgrade
carry no family: they are valid until they expire unless the account is disabled
or deleted.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from agent_server.core.auth import (
    DEFAULT_USER_EXPIRES_IN,
    create_user_access_token,
    verify_user_access_claims,
)

REFRESH_TOKEN_PREFIX = "aart_"
REFRESH_EXPIRES_IN = 60 * 60 * 24 * 30
STATUS_CACHE_SECONDS = 10.0
_MAX_CACHE_ENTRIES = 10_000
MAX_CLIENT_LABEL = 200


class InvalidRefreshToken(Exception):
    pass


@dataclass(frozen=True)
class IssuedTokens:
    user_id: str
    family_id: str
    access_token: str
    access_expires_at: int
    refresh_token: str | None
    refresh_expires_at: int | None


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat().replace("+00:00", "Z")


def iso_from_epoch(epoch: int | None) -> str | None:
    return _iso(epoch) if epoch is not None else None


def _hash(secret: str) -> str:
    return "sha256:" + hashlib.sha256(secret.encode()).hexdigest()


def parse_refresh_token(token: str) -> tuple[str, str] | None:
    if not isinstance(token, str) or not token.startswith(REFRESH_TOKEN_PREFIX):
        return None
    family_id, sep, secret = token[len(REFRESH_TOKEN_PREFIX) :].partition(".")
    if not sep or not family_id.startswith("fam_") or len(secret) < 32:
        return None
    return family_id, secret


class UserTokenService:
    def __init__(self, store: Any, *, clock: Callable[[], float] = time.time) -> None:
        self._store = store
        self._clock = clock
        self._cache: dict[tuple[str, str | None], tuple[bool, float]] = {}

    # -- issuing ------------------------------------------------------------------

    def _access(self, user_id: str, family_id: str) -> tuple[str, int]:
        expires_at = int(self._clock()) + DEFAULT_USER_EXPIRES_IN
        return create_user_access_token(user_id, DEFAULT_USER_EXPIRES_IN, family_id=family_id), expires_at

    async def issue(self, user_id: str, *, client: str) -> IssuedTokens:
        """A new login: a family, an access token and its first refresh token."""

        family_id = f"fam_{secrets.token_urlsafe(18)}"
        secret = secrets.token_urlsafe(32)
        refresh_expires_at = int(self._clock()) + REFRESH_EXPIRES_IN
        await self._store.create_token_family(
            family_id=family_id,
            user_id=user_id,
            client=client[:MAX_CLIENT_LABEL],
            refresh_hash=_hash(secret),
            refresh_expires_at=_iso(refresh_expires_at),
        )
        access, access_expires_at = self._access(user_id, family_id)
        return IssuedTokens(
            user_id=user_id,
            family_id=family_id,
            access_token=access,
            access_expires_at=access_expires_at,
            refresh_token=f"{REFRESH_TOKEN_PREFIX}{family_id}.{secret}",
            refresh_expires_at=refresh_expires_at,
        )

    async def access_in_family(self, user_id: str, family_id: str) -> IssuedTokens:
        """Another access token for an existing login (no refresh rotation); the caller checked the family."""

        access, access_expires_at = self._access(user_id, family_id)
        return IssuedTokens(
            user_id=user_id,
            family_id=family_id,
            access_token=access,
            access_expires_at=access_expires_at,
            refresh_token=None,
            refresh_expires_at=None,
        )

    async def refresh(self, refresh_token: str) -> IssuedTokens:
        parsed = parse_refresh_token(refresh_token)
        if parsed is None:
            raise InvalidRefreshToken()
        family_id, secret = parsed
        new_secret = secrets.token_urlsafe(32)
        refresh_expires_at = int(self._clock()) + REFRESH_EXPIRES_IN
        outcome, family = await self._store.rotate_token_family(
            family_id,
            presented_hash=_hash(secret),
            new_hash=_hash(new_secret),
            refresh_expires_at=_iso(refresh_expires_at),
        )
        if outcome == "reused" and family is not None:
            self._forget(family["userId"], family_id)
        if outcome != "rotated" or family is None:
            raise InvalidRefreshToken()
        if not await self.allows(family["userId"], family_id, cached=False):
            raise InvalidRefreshToken()
        access, access_expires_at = self._access(family["userId"], family_id)
        return IssuedTokens(
            user_id=family["userId"],
            family_id=family_id,
            access_token=access,
            access_expires_at=access_expires_at,
            refresh_token=f"{REFRESH_TOKEN_PREFIX}{family_id}.{new_secret}",
            refresh_expires_at=refresh_expires_at,
        )

    # -- revoking -----------------------------------------------------------------

    def _forget(self, user_id: str, family_id: str | None = None) -> None:
        if family_id is not None:
            self._cache.pop((user_id, family_id), None)
            return
        for key in [key for key in self._cache if key[0] == user_id]:
            self._cache.pop(key, None)

    async def revoke(self, user_id: str, family_id: str, *, reason: str) -> bool:
        revoked = await self._store.revoke_token_family(family_id, user_id=user_id, reason=reason)
        self._forget(user_id, family_id)
        return revoked

    async def revoke_user(self, user_id: str, *, reason: str, keep: str | None = None) -> int:
        count = await self._store.revoke_user_token_families(user_id, reason=reason, keep=keep)
        self._forget(user_id)
        return count

    # -- checking -----------------------------------------------------------------

    async def allows(self, user_id: str, family_id: str | None, *, cached: bool = True) -> bool:
        key = (user_id, family_id)
        now = self._clock()
        hit = self._cache.get(key)
        if cached and hit is not None and hit[1] > now:
            return hit[0]
        allowed = await self._store.token_family_status(user_id, family_id)
        if len(self._cache) >= _MAX_CACHE_ENTRIES:
            self._cache = {k: v for k, v in self._cache.items() if v[1] > now}
            if len(self._cache) >= _MAX_CACHE_ENTRIES:
                self._cache.clear()
        self._cache[key] = (allowed, now + STATUS_CACHE_SECONDS)
        return allowed

    async def authenticate(self, token: str) -> tuple[str, str | None] | None:
        """``(user_id, family_id)`` for a valid access token of an active login, else None."""

        claims = verify_user_access_claims(token)
        if claims is None:
            return None
        if not await self.allows(*claims):
            return None
        return claims
