"""v3 device link end to end: auth, hello, ready, presence, outbox, v2 RPC bridge.

Runs the real Server app (in-process ASGI), a real MeshCall Router and the fake
device from ``scripts/v3_fake_device.py``.
"""

from __future__ import annotations

import asyncio

import httpx
from device_link_helpers import acked as _acked
from device_link_helpers import eventually, server, summary, user_and_device
from device_link_helpers import offline as _offline
from mesh_fixtures import RouterProcess

from scripts.v3_fake_device import connect_device


def test_device_link_handshake_presence_and_outbox(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            registry = app.state.connector_presence
            assert not await registry.is_online(device_id)

            device, welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert welcome["mesh"]["instanceId"] == device_id
                assert welcome["mesh"]["routerUrl"] == mesh_router.url
                assert welcome["e2eeMode"] == "off"
                assert welcome["connectionId"].startswith("lc_")
                assert await app.state.store.connector_link_contract(device_id) == "device-meshcall/1.0"
                assert await registry.is_online(device_id)
                assert (await registry.online_statuses([device_id])) == {device_id: True}

                # Outbox: a summary creates the directory row; the device sees the cumulative ack.
                item = device.state.push_outbox("session.summary", summary("sess_v3a", 12))
                await eventually(lambda: _acked(device, item.oid))
                fields = await app.state.store.session_directory_fields("sess_v3a")
                assert fields["headSeq"] == 12
                assert fields["goalState"] == "active"
                assert fields["displayDevice"] == {"mode": "plain", "payload": {"title": "Fix the build", "cwd": "/repo"}}
                session = await app.state.store.get_session("sess_v3a")
                assert session.title == "Fix the build" and session.connectorId == device_id

                # An older summary never overwrites a newer one.
                stale = device.state.push_outbox("session.summary", summary("sess_v3a", 5, title="old"))
                await eventually(lambda: _acked(device, stale.oid))
                assert (await app.state.store.session_directory_fields("sess_v3a"))["headSeq"] == 12

                # ready with a stale generation is refused.
                stale_ready = await client.post(
                    "/api/v3/device/ready",
                    headers={"Authorization": f"Bearer {access}"},
                    json={"connectionId": "lc_old"},
                )
                assert stale_ready.status_code == 409
                assert stale_ready.json()["detail"]["code"] == "connection_replaced"

                # Floors: the device lost its database; hello hands back max(head_seq, seq_ceiling).
                hello = await client.post(
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
                assert hello.status_code == 200
                assert hello.json()["seqFloors"] == {"sess_v3a": 12}
                # Issuing a new token revoked the old one: the Router closes the device connection
                # (4401) and the held link drops. The Router's close handshake can take ~10 s.
                await eventually(lambda: _offline(registry, device_id), timeout=20)
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_device_goes_offline_when_its_link_dies(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            assert await app.state.connector_presence.is_online(device_id)
            await device.stop()
            await eventually(lambda: _offline(app.state.connector_presence, device_id))
            assert await app.state.device_link_hub.current_connection(device_id) is None

    asyncio.run(scenario())


def test_hello_without_a_router_is_refused_but_the_server_runs(monkeypatch) -> None:
    async def scenario() -> None:
        monkeypatch.setenv("AGENT_SERVER_MESH_ROUTER_URL", "ws://127.0.0.1:9")
        monkeypatch.setenv("AGENT_SERVER_MESH_PASSWORD", "x")
        from agent_server.app import create_app

        app = create_app()
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://server") as client,
        ):
            _headers, device_id, token = await user_and_device(app, client)
            auth = await client.post(
                "/api/v3/device/auth", headers={"Authorization": f"Connector {device_id}:{token}"}
            )
            hello = await client.post(
                "/api/v3/device/hello",
                headers={"Authorization": f"Bearer {auth.json()['accessToken']}"},
                json={
                    "deviceId": device_id,
                    "connectorVersion": "3.0.0",
                    "contractVersions": ["1.0"],
                    "os": "linux",
                    "host": "cli",
                },
            )
            assert hello.status_code == 503
            assert hello.json()["detail"]["code"] == "mesh_unavailable"
            foreign = await client.post(
                "/api/v3/device/hello",
                headers={"Authorization": f"Bearer {auth.json()['accessToken']}"},
                json={
                    "deviceId": "someone_else",
                    "connectorVersion": "3.0.0",
                    "contractVersions": ["1.0"],
                    "os": "linux",
                    "host": "cli",
                },
            )
            assert foreign.status_code == 403

    asyncio.run(scenario())
