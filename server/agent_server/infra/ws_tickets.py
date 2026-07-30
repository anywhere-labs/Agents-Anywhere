from __future__ import annotations

import asyncio
import hashlib
import json
import math
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from agent_server.infra.redis_coordinator import RedisCoordinator


@dataclass(slots=True)
class ClientWsTicket:
    user_id: str
    client_id: str
    session_id: str
    expires_at_monotonic: float
    expires_at: str


class ClientWsTicketManager:
    def __init__(
        self,
        coordinator: RedisCoordinator | None = None,
        *,
        ttl_seconds: float = 60.0,
    ) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self._ttl_seconds = ttl_seconds
        self._tickets: dict[str, ClientWsTicket] = {}
        self._lock = asyncio.Lock()

    async def issue(
        self, *, user_id: str, client_id: str, session_id: str
    ) -> tuple[str, str]:
        token = f"wst_{secrets.token_urlsafe(32)}"
        expires_at_dt = datetime.now(UTC) + timedelta(seconds=self._ttl_seconds)
        ticket = ClientWsTicket(
            user_id=user_id,
            client_id=client_id,
            session_id=session_id,
            expires_at_monotonic=time.monotonic() + self._ttl_seconds,
            expires_at=expires_at_dt.isoformat().replace("+00:00", "Z"),
        )
        ticket_hash = _hash_ticket(token)
        if self._coordinator.distributed:
            await self._coordinator.client.set(
                self._coordinator.key("ws-ticket", ticket_hash),
                json.dumps(
                    {
                        "user_id": ticket.user_id,
                        "client_id": ticket.client_id,
                        "session_id": ticket.session_id,
                        "expires_at": ticket.expires_at,
                    },
                    separators=(",", ":"),
                ),
                ex=max(1, math.ceil(self._ttl_seconds)),
            )
        else:
            async with self._lock:
                self._purge_expired()
                self._tickets[ticket_hash] = ticket
        return token, expires_at_dt.isoformat().replace("+00:00", "Z")

    async def consume(self, token: str, *, session_id: str) -> ClientWsTicket | None:
        ticket_hash = _hash_ticket(token)
        if self._coordinator.distributed:
            raw = await self._coordinator.client.getdel(
                self._coordinator.key("ws-ticket", ticket_hash)
            )
            if not isinstance(raw, str):
                return None
            try:
                payload = json.loads(raw)
                ticket = ClientWsTicket(
                    user_id=payload["user_id"],
                    client_id=payload["client_id"],
                    session_id=payload["session_id"],
                    expires_at_monotonic=time.monotonic(),
                    expires_at=payload["expires_at"],
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                return None
            if ticket.session_id != session_id:
                return None
            # Redis TTL is authoritative across processes. A monotonic clock
            # value cannot be serialized and compared on another host.
            return ticket
        else:
            async with self._lock:
                self._purge_expired()
                ticket = self._tickets.pop(ticket_hash, None)
        if ticket is None:
            return None
        if ticket.session_id != session_id:
            return None
        if time.monotonic() > ticket.expires_at_monotonic:
            return None
        return ticket

    def _purge_expired(self) -> None:
        now = time.monotonic()
        expired = [
            key
            for key, ticket in self._tickets.items()
            if now > ticket.expires_at_monotonic
        ]
        for key in expired:
            self._tickets.pop(key, None)


def _hash_ticket(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
