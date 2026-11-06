from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
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


class _RecordingPool:
    """Stands in for the persistent client so a close can be observed."""

    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


def test_discard_http_client_closes_the_stale_pool(tmp_path) -> None:  # type: ignore[no-untyped-def]
    client = _client(tmp_path)
    stale = _RecordingPool()
    client._http_client = stale  # type: ignore[assignment]

    async def exercise() -> None:
        await client._discard_http_client()
        assert client._http_client is not stale
        assert isinstance(client._http_client, httpx.AsyncClient)
        await client._http_client.aclose()

    asyncio.run(exercise())
    assert stale.closed


def test_run_forever_discards_the_pool_before_reconnecting(
    tmp_path,  # type: ignore[no-untyped-def]
    monkeypatch,  # type: ignore[no-untyped-def]
) -> None:
    client = _client(tmp_path, reconnect_seconds=0)
    discard = AsyncMock()
    monkeypatch.setattr(client, "_discard_http_client", discard)

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
