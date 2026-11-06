from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from connector.core.config import ConnectorConfig
from connector.server.client import BackendRpcClient
from connector.server.errors import ConnectorNetworkError


def _client(tmp_path, **overrides) -> BackendRpcClient:  # type: ignore[no-untyped-def]
    return BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            state_path=str(tmp_path / "sync.json"),
            **overrides,
        ),
        agent_runtime_providers=(),
    )


def test_run_forever_discards_the_route_before_reconnecting(
    tmp_path,  # type: ignore[no-untyped-def]
    monkeypatch,  # type: ignore[no-untyped-def]
) -> None:
    # The pool that just failed may hold sockets the peer has forgotten; the next attempt
    # must open fresh ones instead of waiting on them.
    client = _client(tmp_path, reconnect_seconds=0)
    discard = AsyncMock()
    monkeypatch.setattr(client._egress, "discard_route", discard)

    attempts = 0

    async def run_once() -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ConnectorNetworkError("link dropped")
        raise asyncio.CancelledError

    monkeypatch.setattr(client, "run_once", run_once)

    async def exercise() -> None:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(client.run_forever(), timeout=5)

    asyncio.run(exercise())
    assert discard.await_count == 1
