from __future__ import annotations

import asyncio
from typing import Any

from connector.runtime_protocol import RuntimeSessionStateCache
from connector.runtime_protocol.host import RuntimeHostClient


class FakeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.updates: list[dict[str, Any]] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: Any = None,
        selections: dict[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.updates.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "status": status,
                "selections": dict(selections or {}),
                "external_session_id": external_session_id,
                "status_reason": status_reason,
                "error": dict(error) if error is not None else None,
                "metadata": dict(metadata or {}),
            }
        )


def test_runtime_session_state_cache_skips_identical_updates() -> None:
    async def run() -> tuple[int, bool]:
        host = FakeHost()
        cache = RuntimeSessionStateCache("codex", host)

        first = await cache.update(
            session_id="sess_1",
            external_session_id="thread_1",
            status="running",
            metadata={"source": "codex.turn/started"},
        )
        second = await cache.update(
            session_id="sess_1",
            external_session_id="thread_1",
            status="running",
            metadata={"source": "codex.turn/started"},
        )
        return len(host.updates), first == second

    update_count, same_state = asyncio.run(run())
    assert same_state
    assert update_count == 1
