"""Pairing codes in Redis, never in the database (``05-server.md`` §8).

v2 kept ``pairing_codes`` rows with the six-digit code and the issued
Connector token in plaintext, and never cleared them. Now:

- records live only for the pairing's TTL (plus a short tail so a late poll still
  reads ``expired``/``consumed``);
- the code is stored as ``HMAC(server secret, code)`` and the pairing id as its
  SHA-256, so a Redis dump does not reveal either;
- the Connector token handed over on ``poll`` is sealed with AES-GCM under a key
  derived from the server secret, and deleted the moment it is read.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from agent_server.core.auth import server_secret
from agent_server.infra.redis_coordinator import RedisCoordinator

AFTERLIFE_SECONDS = 600


class PairingNotFound(KeyError):
    pass


class PairingNotClaimable(ValueError):
    pass


@dataclass(frozen=True)
class PairingClaim:
    pairing_hash: str
    server_url: str | None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class PairingStore:
    def __init__(self, coordinator: RedisCoordinator, *, clock=time.time) -> None:
        self._coordinator = coordinator
        self._clock = clock
        self._local: dict[str, tuple[str, float]] = {}

    # -- keys and sealing ---------------------------------------------------------

    def _code_key(self, code: str) -> str:
        digest = hmac.new(server_secret(), f"pairing-code:{code}".encode(), hashlib.sha256).hexdigest()
        return self._coordinator.key("pairing", "code", digest)

    def _record_key(self, pairing_hash: str) -> str:
        return self._coordinator.key("pairing", "id", pairing_hash)

    @staticmethod
    def _aead() -> AESGCM:
        return AESGCM(hmac.new(server_secret(), b"pairing-seal-v1", hashlib.sha256).digest())

    def _seal(self, pairing_hash: str, token: str) -> str:
        nonce = secrets.token_bytes(12)
        sealed = self._aead().encrypt(nonce, token.encode(), pairing_hash.encode())
        return base64.urlsafe_b64encode(nonce + sealed).decode()

    def _open(self, pairing_hash: str, sealed: str) -> str:
        raw = base64.urlsafe_b64decode(sealed.encode())
        return self._aead().decrypt(raw[:12], raw[12:], pairing_hash.encode()).decode()

    # -- storage (Redis, or this process when Redis is not configured) --------------

    async def _set(self, key: str, value: str, ttl: float, *, nx: bool = False) -> bool:
        if self._coordinator.distributed:
            return bool(await self._coordinator.client.set(key, value, px=max(1, int(ttl * 1000)), nx=nx))
        now = self._clock()
        current = self._local.get(key)
        if nx and current is not None and current[1] > now:
            return False
        self._local[key] = (value, now + ttl)
        return True

    async def _get(self, key: str) -> str | None:
        if self._coordinator.distributed:
            raw = await self._coordinator.client.get(key)
            return raw.decode() if isinstance(raw, bytes) else raw
        current = self._local.get(key)
        if current is None or current[1] <= self._clock():
            self._local.pop(key, None)
            return None
        return current[0]

    async def _delete(self, key: str) -> None:
        if self._coordinator.distributed:
            await self._coordinator.client.delete(key)
        else:
            self._local.pop(key, None)

    async def _ttl(self, key: str) -> float:
        if self._coordinator.distributed:
            ms = await self._coordinator.client.pttl(key)
            return max(ms, 1) / 1000 if isinstance(ms, int) else 1.0
        current = self._local.get(key)
        return max(current[1] - self._clock(), 0.001) if current else 0.001

    async def _load(self, pairing_hash: str) -> dict[str, Any] | None:
        raw = await self._get(self._record_key(pairing_hash))
        return json.loads(raw) if raw else None

    async def _save(self, pairing_hash: str, record: dict[str, Any]) -> None:
        key = self._record_key(pairing_hash)
        await self._set(key, json.dumps(record, separators=(",", ":")), await self._ttl(key))

    # -- flow ---------------------------------------------------------------------

    async def start(self, *, server_url: str | None, ttl_seconds: int) -> dict[str, str]:
        pairing_id = f"pair_{secrets.token_urlsafe(18)}"
        pairing_hash = _sha(pairing_id)
        expires = self._clock() + ttl_seconds
        for _ in range(20):
            code = f"{secrets.randbelow(1_000_000):06d}"
            if await self._set(self._code_key(code), pairing_hash, ttl_seconds, nx=True):
                break
        else:
            raise RuntimeError("could not allocate a pairing code")
        record = {"status": "pending", "serverUrl": server_url, "expiresAt": expires, "codeKey": self._code_key(code)}
        await self._set(self._record_key(pairing_hash), json.dumps(record), ttl_seconds + AFTERLIFE_SECONDS)
        return {"pairingId": pairing_id, "code": code, "expiresAt": _iso(expires)}

    async def begin_claim(self, code: str) -> PairingClaim:
        """Check a code before a Connector is chosen or created; raises if it cannot be claimed."""

        pairing_hash = await self._get(self._code_key(code))
        if pairing_hash is None:
            raise PairingNotFound(code)
        record = await self._load(pairing_hash)
        if record is None or record["status"] != "pending" or record["expiresAt"] <= self._clock():
            raise PairingNotClaimable("pairing code is not claimable")
        return PairingClaim(pairing_hash=pairing_hash, server_url=record.get("serverUrl"))

    async def finish_claim(
        self, claim: PairingClaim, *, connector_id: str, connector_token: str, server_url: str | None
    ) -> None:
        record = await self._load(claim.pairing_hash)
        if record is None or record["status"] != "pending":
            raise PairingNotClaimable("pairing code is not claimable")
        await self._delete(record.pop("codeKey"))
        record.update(
            status="claimed",
            connectorId=connector_id,
            sealedToken=self._seal(claim.pairing_hash, connector_token),
        )
        if server_url is not None:
            record["serverUrl"] = server_url
        await self._save(claim.pairing_hash, record)

    async def poll(self, pairing_id: str) -> dict[str, Any]:
        """``{"status", "expiresAt", "config"?}``; the token is returned once and then forgotten."""

        pairing_hash = _sha(pairing_id)
        record = await self._load(pairing_hash)
        if record is None:
            raise PairingNotFound(pairing_id)
        expires_at = _iso(record["expiresAt"])
        if record["status"] == "pending":
            if record["expiresAt"] <= self._clock():
                return {"status": "expired", "expiresAt": expires_at}
            return {"status": "pending", "expiresAt": expires_at}
        if record["status"] != "claimed":
            return {"status": record["status"], "expiresAt": expires_at}
        if not record.get("serverUrl"):
            raise PairingNotClaimable("claimed pairing is missing connector config")
        token = self._open(pairing_hash, record.pop("sealedToken"))
        connector_id = record["connectorId"]
        record["status"] = "consumed"
        await self._save(pairing_hash, record)
        return {
            "status": "claimed",
            "expiresAt": expires_at,
            "config": {"serverUrl": record["serverUrl"], "connectorId": connector_id, "connectorToken": token},
        }
