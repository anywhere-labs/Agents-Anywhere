from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


@dataclass(slots=True)
class ClientWsTicket:
    user_id: str
    client_id: str
    session_id: str
    expires_at_monotonic: float
    expires_at: str


class ClientWsTicketManager:
    def __init__(self, *, ttl_seconds: float = 60.0) -> None:
        self._ttl_seconds = ttl_seconds
        self._tickets: dict[str, ClientWsTicket] = {}

    def issue(self, *, user_id: str, client_id: str, session_id: str) -> tuple[str, str]:
        self._purge_expired()
        token = f"wst_{secrets.token_urlsafe(32)}"
        expires_at_dt = datetime.now(UTC) + timedelta(seconds=self._ttl_seconds)
        self._tickets[_hash_ticket(token)] = ClientWsTicket(
            user_id=user_id,
            client_id=client_id,
            session_id=session_id,
            expires_at_monotonic=time.monotonic() + self._ttl_seconds,
            expires_at=expires_at_dt.isoformat().replace("+00:00", "Z"),
        )
        return token, expires_at_dt.isoformat().replace("+00:00", "Z")

    def consume(self, token: str, *, session_id: str) -> ClientWsTicket | None:
        self._purge_expired()
        ticket = self._tickets.pop(_hash_ticket(token), None)
        if ticket is None:
            return None
        if ticket.session_id != session_id:
            return None
        if time.monotonic() > ticket.expires_at_monotonic:
            return None
        return ticket

    def _purge_expired(self) -> None:
        now = time.monotonic()
        expired = [key for key, ticket in self._tickets.items() if now > ticket.expires_at_monotonic]
        for key in expired:
            self._tickets.pop(key, None)


def _hash_ticket(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
