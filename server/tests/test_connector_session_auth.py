from __future__ import annotations

import asyncio
import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent_server.infra.connector_session_auth import ConnectorSessionAuthorization


@pytest.mark.parametrize("change,reason", [
    ("rotate", "credential_changed"), ("revoke", "credential_revoked"), ("connection", "base_connection_changed"),
])
def test_base_authorization_invalidates_the_exact_old_session(change, reason):
    async def exercise():
        cache = SimpleNamespace(healthy=True, get=AsyncMock(return_value="credential"))
        current = AsyncMock(return_value=True)
        disconnected = asyncio.Event()
        closed = []
        async def disconnect():
            closed.append("old-base")
            disconnected.set()
        authorization = ConnectorSessionAuthorization("device", "old-base", hashlib.sha256(b"credential").hexdigest(),
                                                     cache, current, disconnect)
        authorization.start()
        try:
            assert await asyncio.wait_for(authorization.valid(), 2)
            if change == "connection":
                current.return_value = False
            else:
                cache.get.return_value = "new" if change == "rotate" else ""
            await asyncio.wait_for(disconnected.wait(), 3)
            assert not await authorization.valid() and authorization.reason == reason
            assert closed == ["old-base"]
        finally:
            await authorization.close()
    asyncio.run(exercise())


def test_session_snapshot_does_not_query_credential_storage_per_request():
    async def exercise():
        cache = SimpleNamespace(healthy=True, get=AsyncMock(return_value="credential"))
        authorization = ConnectorSessionAuthorization("device", "base", hashlib.sha256(b"credential").hexdigest(),
                                                     cache, AsyncMock(return_value=True), AsyncMock())
        authorization.start()
        try:
            assert all(await asyncio.gather(*(authorization.valid() for _ in range(100))))
            cache.get.assert_awaited_once_with("device")
            cache.healthy = False
            assert not await authorization.valid()
        finally:
            await authorization.close()
    asyncio.run(exercise())
