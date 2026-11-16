"""Workspace roots of Connector terminals, in Redis (``05-server.md`` §3.1).

v2 kept them in ``connector_terminal_roots``. The PTY lives on the device; the Server
only needs to remember which workspace root and cwd it opened a terminal with, so
the relay can re-attach and the list can show them. That is runtime state, not
data worth a table:

- one Redis hash per Connector, ``terminal_id`` -> ``{"sessionId", "root", "cwd"}``;
- the hash expires ``TTL_SECONDS`` after its last write (opening or listing
  terminals refreshes it), so an abandoned device does not leave keys forever;
- without Redis (single-process mode) the same records live in this process.

Losing a record only loses the root shown for a terminal and the ability to
re-attach the relay after the Server forgets it; the terminal on the device is not
affected.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from agent_server.infra.redis_coordinator import RedisCoordinator

TTL_SECONDS = 30 * 24 * 3600


class TerminalRootStore:
    def __init__(self, coordinator: RedisCoordinator, *, ttl_seconds: int = TTL_SECONDS) -> None:
        self._coordinator = coordinator
        self._ttl_seconds = ttl_seconds
        self._local: dict[str, dict[str, dict[str, str]]] = {}

    def _key(self, connector_id: str) -> str:
        return self._coordinator.key("terminal-roots", connector_id)

    @staticmethod
    def _decode(raw: object) -> dict[str, str] | None:
        if isinstance(raw, bytes):
            raw = raw.decode()
        if not isinstance(raw, str):
            return None
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(value, dict):
            return None
        if not all(isinstance(value.get(field), str) for field in ("sessionId", "root", "cwd")):
            return None
        return value

    async def _all(self, connector_id: str) -> dict[str, dict[str, str]]:
        if not self._coordinator.distributed:
            return dict(self._local.get(connector_id, {}))
        raw = await self._coordinator.client.hgetall(self._key(connector_id))
        records: dict[str, dict[str, str]] = {}
        for field, value in raw.items():
            terminal_id = field.decode() if isinstance(field, bytes) else str(field)
            record = self._decode(value)
            if record is not None:
                records[terminal_id] = record
        return records

    async def _remove(self, connector_id: str, terminal_ids: Iterable[str]) -> None:
        ids = list(terminal_ids)
        if not ids:
            return
        if not self._coordinator.distributed:
            records = self._local.get(connector_id)
            if records is None:
                return
            for terminal_id in ids:
                records.pop(terminal_id, None)
            if not records:
                self._local.pop(connector_id, None)
            return
        await self._coordinator.client.hdel(self._key(connector_id), *ids)

    async def record_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
        session_id: str,
        root: str,
        cwd: str,
    ) -> None:
        record = {"sessionId": session_id, "root": root, "cwd": cwd}
        if not self._coordinator.distributed:
            self._local.setdefault(connector_id, {})[terminal_id] = record
            return
        key = self._key(connector_id)
        async with self._coordinator.client.pipeline(transaction=True) as pipe:
            pipe.hset(key, terminal_id, json.dumps(record, separators=(",", ":")))
            pipe.expire(key, self._ttl_seconds)
            await pipe.execute()

    async def get_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> dict[str, str] | None:
        if not self._coordinator.distributed:
            record = self._local.get(connector_id, {}).get(terminal_id)
        else:
            record = self._decode(
                await self._coordinator.client.hget(self._key(connector_id), terminal_id)
            )
        if record is None:
            return None
        return {"root": record["root"], "cwd": record["cwd"]}

    async def list_connector_terminal_roots(
        self,
        *,
        connector_id: str,
        session_id: str,
    ) -> dict[str, dict[str, str]]:
        return {
            terminal_id: {"root": record["root"], "cwd": record["cwd"]}
            for terminal_id, record in (await self._all(connector_id)).items()
            if record["sessionId"] == session_id
        }

    async def prune_connector_terminal_roots(
        self,
        *,
        connector_id: str,
        session_id: str,
        terminal_ids: set[str],
    ) -> None:
        """Forget this session's terminals the device no longer lists."""

        records = await self._all(connector_id)
        await self._remove(
            connector_id,
            (
                terminal_id
                for terminal_id, record in records.items()
                if record["sessionId"] == session_id and terminal_id not in terminal_ids
            ),
        )
        if self._coordinator.distributed and records:
            await self._coordinator.client.expire(self._key(connector_id), self._ttl_seconds)

    async def forget_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> None:
        await self._remove(connector_id, [terminal_id])

    async def forget_session_terminal_roots(
        self,
        connector_id: str,
        session_ids: Iterable[str],
    ) -> None:
        """Forget the terminals opened for the given sessions of a device."""

        wanted = set(session_ids)
        if not wanted:
            return
        records = await self._all(connector_id)
        await self._remove(
            connector_id,
            (terminal_id for terminal_id, record in records.items() if record["sessionId"] in wanted),
        )

    async def forget_connector_terminal_roots(self, connector_id: str) -> None:
        """Forget every terminal of a deleted device."""

        if not self._coordinator.distributed:
            self._local.pop(connector_id, None)
            return
        await self._coordinator.client.delete(self._key(connector_id))
