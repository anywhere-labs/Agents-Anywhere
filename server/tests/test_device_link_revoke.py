"""Revoking or deleting a v3 device ends its MeshCall link, from any worker.

``POST /connectors/{id}/revoke`` and ``DELETE /connectors/{id}`` call ``DeviceLinkService.revoke``:
the Router token is revoked, the link record removed, the link dropped and the presence lease
deleted; hello and ready with the old credentials or the old connectionId are refused.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from device_link_helpers import eventually, server, user_and_device
from device_link_helpers import offline as _offline
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis
from mesh_fixtures import RouterProcess

from agent_server.infra.device_link import DeviceLinkHub, HeldLink
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.services.device_link import DeviceLinkService
from scripts.v3_fake_device import connect_device

DEVICE = "conn_r1"


class _FakeMesh:
    def __init__(self) -> None:
        self.revoked: list[str] = []

    async def revoke_token(self, token_id: str) -> bool:
        self.revoked.append(token_id)
        return True


def _service(hub: DeviceLinkHub, mesh: _FakeMesh, coordinator: RedisCoordinator) -> DeviceLinkService:
    return DeviceLinkService(None, mesh, hub, coordinator, None)  # type: ignore[arg-type]


@pytest.mark.parametrize("distributed", [True, False])
def test_revoke_from_a_worker_that_does_not_hold_the_link(distributed: bool) -> None:
    async def scenario() -> None:
        mesh = _FakeMesh()
        if distributed:
            redis = FakeServer()
            first = RedisCoordinator(prefix="t", client=FakeRedis(server=redis))
            second = RedisCoordinator(prefix="t", client=FakeRedis(server=redis))
            holder = DeviceLinkHub(None, first, worker_id="w_a")  # type: ignore[arg-type]
            other_hub = DeviceLinkHub(None, second, worker_id="w_b")  # type: ignore[arg-type]
            other = _service(other_hub, mesh, second)
        else:
            # One process without Redis: the same hub holds the link and takes the revoke.
            coordinator = RedisCoordinator()
            holder = other_hub = DeviceLinkHub(None, coordinator, worker_id="w_a")  # type: ignore[arg-type]
            other = _service(holder, mesh, coordinator)
        presence: list[tuple[str, bool]] = []

        async def on_presence(device_id: str, online: bool) -> None:
            presence.append((device_id, online))

        holder.on_presence = on_presence
        held = HeldLink(device_id=DEVICE, connection_id="lc_1", lease_value=holder._lease_value("lc_1"))
        holder._links[DEVICE] = held
        assert await holder._write_lease(held, first=True)
        held.first_item.set()
        await other._swap_record(DEVICE, {"connectionId": "lc_1", "tokenId": "tok_1"})
        assert await other_hub.is_online(DEVICE)

        await other.revoke(DEVICE, "connector deleted")

        assert mesh.revoked == ["tok_1"]
        assert await other.link_record(DEVICE) is None
        # Every worker sees the device offline at once.
        assert not await other_hub.is_online(DEVICE)
        if distributed:
            # The holder notices on its next renewal, closes its streams and reports the device offline.
            assert not await holder._write_lease(held, first=False)
            await holder._finish(held)
        assert holder.held_devices() == []
        assert presence == [(DEVICE, False)]

        # A v2 WebSocket lease is not the v3 link's to delete.
        if distributed:
            await second.client.set(other_hub.lease_key(DEVICE), json.dumps({"transport": "ws", "ready": True}))
            assert not await other_hub.evict(DEVICE)
            assert await second.client.get(other_hub.lease_key(DEVICE))

    asyncio.run(scenario())


def test_v2_disconnect_leaves_a_v3_lease_to_the_device_link() -> None:
    """Deleting a v3 device in a multi-worker deployment must not fail on the v2 disconnect route."""

    async def scenario() -> None:
        from agent_server.infra.connector_presence_registry import (
            ConnectorPresenceRegistry,
        )

        coordinator = RedisCoordinator(prefix="t", client=FakeRedis(server=FakeServer()))
        hub = DeviceLinkHub(None, coordinator, worker_id="w_a")  # type: ignore[arg-type]
        held = HeldLink(device_id=DEVICE, connection_id="lc_1", lease_value=hub._lease_value("lc_1"))
        assert await hub._write_lease(held, first=True)
        manager = ConnectorPresenceRegistry(coordinator, instance_id="w_b")
        assert await manager.disconnect(DEVICE, reason="connector deleted") is False
        assert await hub.is_online(DEVICE)

    asyncio.run(scenario())


async def _hello(client, access: str, device_id: str):
    return await client.post(
        "/api/v3/device/hello",
        headers={"Authorization": f"Bearer {access}"},
        json={
            "deviceId": device_id,
            "connectorVersion": "3.0.0",
            "contractVersions": ["1.0"],
            "os": "macos",
            "host": "cli",
            "sessionsHead": [],
        },
    )


async def _ready(client, access: str, connection_id: str):
    return await client.post(
        "/api/v3/device/ready", headers={"Authorization": f"Bearer {access}"}, json={"connectionId": connection_id}
    )


async def _unregistered(mesh, device_id: str) -> bool:
    return not await mesh.registered_services(device_id)


def test_revoking_credentials_ends_the_v3_link(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert await app.state.connector_presence.is_online(device_id)
                revoked = await client.post(f"/api/v2/connectors/{device_id}/revoke", headers=headers)
                assert revoked.status_code == 200, revoked.text

                # Offline everywhere at once, the record and the hold are gone.
                assert not await app.state.connector_presence.is_online(device_id)
                assert await app.state.device_link.link_record(device_id) is None
                assert device_id not in app.state.device_link_hub.held_devices()
                assert revoked.json()["connector"]["status"] == "offline"
                # The Router token is revoked: the Router closes the device's connection.
                await eventually(lambda: _unregistered(app.state.device_mesh, device_id), timeout=20)

                # The old credentials say neither hello nor ready.
                assert (await _hello(client, access, device_id)).status_code == 401
                assert (await _ready(client, access, welcome["connectionId"])).status_code == 401
                # With the new credentials, the old connectionId is not the current one any more.
                auth = await client.post(
                    "/api/v3/device/auth",
                    headers={"Authorization": f"Connector {device_id}:{revoked.json()['connectorToken']}"},
                )
                fresh = auth.json()["accessToken"]
                stale = await _ready(client, fresh, welcome["connectionId"])
                assert stale.status_code == 409 and stale.json()["detail"]["code"] == "connection_replaced"
                assert not await app.state.connector_presence.is_online(device_id)
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_deleting_a_v3_device_ends_its_link(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                deleted = await client.delete(f"/api/v2/connectors/{device_id}", headers=headers)
                assert deleted.status_code == 204, deleted.text
                assert not await app.state.connector_presence.is_online(device_id)
                assert await app.state.device_link.link_record(device_id) is None
                assert device_id not in app.state.device_link_hub.held_devices()
                await eventually(lambda: _unregistered(app.state.device_mesh, device_id), timeout=20)
                await eventually(lambda: _offline(app.state.connector_presence, device_id))
                assert (await _hello(client, access, device_id)).status_code == 401
                assert (await _ready(client, access, welcome["connectionId"])).status_code == 401
                listed = await client.get("/api/v2/connectors", headers=headers)
                assert device_id not in {c["id"] for c in listed.json()["connectors"]}
            finally:
                await device.stop()

    asyncio.run(scenario())
