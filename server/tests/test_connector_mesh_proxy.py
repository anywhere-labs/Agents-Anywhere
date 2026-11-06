from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent_server.api import connector_mesh as api
from agent_server.infra.connector_mesh_routes import MeshRoute

ROUTE = MeshRoute("device", "base", "old-link", "router", "worker", 1, "owner")


@pytest.fixture
def proxy(monkeypatch):
    incoming, outgoing, delivered = (asyncio.Queue() for _ in range(3))
    published, upstream_closed = asyncio.Event(), asyncio.Event()
    records = []

    async def receive():
        return await incoming.get()

    async def send_text(message):
        delivered.put_nowait(message)

    @asynccontextmanager
    async def lifecycle(_identity):
        yield

    async def publish(_route):
        published.set()
        return True

    class Upstream:
        send = AsyncMock()

        def __aiter__(self):
            return self.messages()

        async def messages(self):
            while True:
                yield await outgoing.get()

    @asynccontextmanager
    async def connect(*_args, **_kwargs):
        try:
            yield Upstream()
        finally:
            upstream_closed.set()

    credentials = SimpleNamespace(healthy=True, get=AsyncMock(return_value="fingerprint"))
    grant = {"connectorId": "device", "connectionId": "base", "fingerprint": "fingerprint",
             "linkId": "old-link", "generation": 1, "expiresAt": time.time() + 900}
    routes = SimpleNamespace(publish=AsyncMock(side_effect=publish), renew=AsyncMock(return_value=True),
                             remove=AsyncMock(), get=AsyncMock())
    auth = SimpleNamespace(revoke_token=AsyncMock())
    mesh = SimpleNamespace(credentials=credentials, grant=AsyncMock(return_value=grant), routes=routes,
                           route_for=Mock(return_value=ROUTE), registered=AsyncMock(return_value=True),
                           authorize_router=AsyncMock(return_value=SimpleNamespace(token="router-token", token_id="token-id")),
                           router_url="ws://router.invalid", connection=lambda: SimpleNamespace(auth=auth))
    rpc = SimpleNamespace(instance_id="worker", is_connection_id_current=AsyncMock(return_value=True))
    state = SimpleNamespace(connector_mesh=mesh, rpc=rpc, store=SimpleNamespace(connector_lifecycle=lifecycle))
    websocket = SimpleNamespace(app=SimpleNamespace(state=state), headers={"authorization": "Bearer proxy-grant"},
                                receive=receive, accept=AsyncMock(), close=AsyncMock(), send_text=send_text, send_bytes=AsyncMock())
    monkeypatch.setattr(api.websockets, "connect", connect)
    monkeypatch.setattr(api, "control_log", lambda event, **fields: records.append({"event": event, **fields}))
    return SimpleNamespace(ws=websocket, mesh=mesh, rpc=rpc, incoming=incoming, outgoing=outgoing,
                           delivered=delivered, published=published, closed=upstream_closed, auth=auth, records=records)


def test_expired_grant_is_rejected_before_credential_lookup_or_router_authorization(proxy):
    async def exercise():
        proxy.mesh.grant.return_value["expiresAt"] = time.time() - 1
        await api.mesh_proxy(proxy.ws)
        assert proxy.ws.close.await_args.kwargs["code"] == 1008
        proxy.mesh.credentials.get.assert_not_awaited()
        proxy.mesh.authorize_router.assert_not_awaited()
        proxy.ws.accept.assert_not_awaited()
    asyncio.run(exercise())


def test_proxy_disconnect_cleans_route_token_and_all_background_tasks(proxy):
    async def exercise():
        running = asyncio.create_task(api.mesh_proxy(proxy.ws))
        try:
            await asyncio.wait_for(proxy.published.wait(), 2)
            proxy.incoming.put_nowait({"type": "websocket.disconnect"})
            await asyncio.wait_for(running, 2)
            proxy.mesh.routes.remove.assert_awaited_once_with(ROUTE)
            proxy.auth.revoke_token.assert_awaited_once_with("token-id")
            assert proxy.closed.is_set() and proxy.ws.close.await_count == 1
            assert not [task for task in asyncio.all_tasks() if task.get_name().startswith("mesh.")]
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
    asyncio.run(exercise())


def test_newer_route_keeps_old_proxy_open_for_inflight_responses(proxy, monkeypatch):
    monkeypatch.setattr(api, "ROUTE_RENEW_SECONDS", 0)
    async def exercise():
        checked = asyncio.Event()
        async def replacement(_identity):
            checked.set()
            return replace(ROUTE, generation=2, link_id="new-link", owner_id="new-owner")
        proxy.mesh.routes.renew.return_value = False
        proxy.mesh.routes.get.side_effect = replacement
        running = asyncio.create_task(api.mesh_proxy(proxy.ws))
        try:
            await asyncio.wait_for(checked.wait(), 3)
            assert not running.done() and not proxy.closed.is_set()
            proxy.auth.revoke_token.assert_not_awaited()
            proxy.outgoing.put_nowait("old call completed")
            assert await asyncio.wait_for(proxy.delivered.get(), 2) == "old call completed"
            assert any(row["event"] == "proxy.draining" for row in proxy.records)
            proxy.incoming.put_nowait({"type": "websocket.disconnect"})
            await asyncio.wait_for(running, 2)
            proxy.mesh.routes.remove.assert_awaited_once_with(ROUTE)
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
    asyncio.run(exercise())


@pytest.mark.parametrize("change,reason", [
    ("revoke", "credential_revoked"), ("rotate", "credential_changed"), ("connection", "base_connection_changed"),
])
def test_idle_proxy_rechecks_revocation_and_base_connection_without_message_frames(proxy, change, reason):
    async def exercise():
        running = asyncio.create_task(api.mesh_proxy(proxy.ws))
        try:
            await asyncio.wait_for(proxy.published.wait(), 2)
            if change == "connection":
                proxy.rpc.is_connection_id_current.return_value = False
            else:
                proxy.mesh.credentials.get.return_value = "" if change == "revoke" else "replacement"
            await asyncio.wait_for(running, 3)
            assert proxy.closed.is_set()
            assert any(row["event"] == "proxy.closed" and row["reason"] == reason for row in proxy.records)
            proxy.auth.revoke_token.assert_awaited_once_with("token-id")
            proxy.mesh.routes.remove.assert_awaited_once_with(ROUTE)
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
    asyncio.run(exercise())
