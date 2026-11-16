"""Port preview state shared by every Server worker and preview-auth (Redis, or this process).

- ``slug`` keys: the state of each open preview, read by preview-auth on every request
  (``core.preview_access.state_key``). Deleted when the preview closes; they expire with it.
- ``ticket`` keys: one-time tickets (60 s) that preview-auth redeems through the Server.
- ``ports`` keys: the device's current listening ports (``port.listening``), so a session
  subscriber on any worker can be told about them when it subscribes.

Without Redis (one process) the same records live in a dict, which is enough for
development; preview-auth always needs Redis.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

from agent_server.core.preview_access import ports_key, state_key, ticket_key
from agent_server.infra.redis_coordinator import RedisCoordinator

PORTS_TTL_SECONDS = 15 * 60


class PreviewStateStore:
    def __init__(self, coordinator: RedisCoordinator, *, clock=time.time) -> None:
        self._coordinator = coordinator
        self._clock = clock
        self._local: dict[str, tuple[str, float]] = {}

    @property
    def prefix(self) -> str:
        return self._coordinator.prefix

    async def _set(self, key: str, value: Any, ttl: float) -> None:
        raw = json.dumps(value, separators=(",", ":"))
        if self._coordinator.distributed:
            await self._coordinator.client.set(key, raw, px=max(1, int(ttl * 1000)))
        else:
            self._local[key] = (raw, self._clock() + ttl)

    async def _get(self, key: str, *, delete: bool = False) -> Any:
        if self._coordinator.distributed:
            client = self._coordinator.client
            raw = await (client.getdel(key) if delete else client.get(key))
        else:
            current = self._local.pop(key, None) if delete else self._local.get(key)
            raw = current[0] if current is not None and current[1] > self._clock() else None
        if raw is None:
            return None
        return json.loads(raw.decode() if isinstance(raw, bytes) else raw)

    async def _delete(self, key: str) -> None:
        if self._coordinator.distributed:
            await self._coordinator.client.delete(key)
        else:
            self._local.pop(key, None)

    # -- slugs ------------------------------------------------------------------

    async def publish_slug(self, slug: str, state: dict[str, Any], *, ttl_seconds: float) -> None:
        await self._set(state_key(self.prefix, slug), state, max(ttl_seconds, 1))

    async def slug_state(self, slug: str) -> dict[str, Any] | None:
        return await self._get(state_key(self.prefix, slug))

    async def drop_slug(self, slug: str) -> None:
        await self._delete(state_key(self.prefix, slug))

    # -- tickets ----------------------------------------------------------------

    async def issue_ticket(self, claims: dict[str, Any], *, ttl_seconds: float) -> str:
        ticket = secrets.token_urlsafe(32)
        await self._set(ticket_key(self.prefix, ticket), claims, ttl_seconds)
        return ticket

    async def redeem_ticket(self, ticket: str) -> dict[str, Any] | None:
        """The ticket's claims, once; None when it is unknown, used or expired."""

        return await self._get(ticket_key(self.prefix, ticket), delete=True)

    # -- listening ports ----------------------------------------------------------

    async def set_ports(self, device_id: str, ports: list[dict[str, Any]]) -> None:
        await self._set(ports_key(self.prefix, device_id), ports, PORTS_TTL_SECONDS)

    async def ports(self, device_id: str) -> list[dict[str, Any]]:
        value = await self._get(ports_key(self.prefix, device_id))
        return value if isinstance(value, list) else []

    async def drop_ports(self, device_id: str) -> None:
        await self._delete(ports_key(self.prefix, device_id))
