"""``WS /api/v3/tunnel`` <-> ``Secure/channel`` forwarding (real Router, fake device that echoes)."""

from __future__ import annotations

import asyncio

from device_link_helpers import eventually, offline, server, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.services.device_tunnel import TunnelSession
from scripts.v3_fake_device import connect_device

CLIENT = "cli_" + "a" * 26


def _route(device_id: str, ch: str = "c1") -> dict:
    return {"deviceId": device_id, "clientId": CLIENT, "ch": ch}


def test_frames_are_forwarded_both_ways_and_ends_are_reported(mesh_router: RouterProcess, monkeypatch) -> None:
    # Devices register ``Secure`` only in E2EE required mode (``e2ee-registration.json``).
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            user_id = (await app.state.store.get_connector(device_id)).userId
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            frames: asyncio.Queue = asyncio.Queue()
            tunnel = TunnelSession(
                user_id=user_id,
                store=app.state.store,
                mesh=app.state.device_mesh,
                hub=app.state.device_link_hub,
                send=frames.put,
            )
            try:
                for n in range(3):
                    await tunnel.handle({"t": "tun", "route": _route(device_id), "n": n, "ct": f"m{n}"})
                for n in range(3):
                    frame = await asyncio.wait_for(frames.get(), 10)
                    assert frame == {"t": "tun", "route": _route(device_id), "n": n, "ct": f"echo:m{n}"}
                # A second channel on the same socket is independent.
                await tunnel.handle({"t": "tun", "route": _route(device_id, "c2"), "n": 0, "ct": "x"})
                assert (await asyncio.wait_for(frames.get(), 10))["route"]["ch"] == "c2"
                assert tunnel.open_channels == 2
                assert device.state.calls.count("secure.channel") == 2

                # The device returns: the client gets end/closed.
                await tunnel.handle({"t": "tun", "route": _route(device_id), "n": 3, "ct": "end"})
                assert await asyncio.wait_for(frames.get(), 10) == {
                    "t": "end",
                    "route": _route(device_id),
                    "code": "closed",
                }
                # The device fails the call with an AA code: it reaches the client.
                await tunnel.handle({"t": "tun", "route": _route(device_id, "c3"), "n": 0, "ct": "fail"})
                end = await asyncio.wait_for(frames.get(), 10)
                assert end["t"] == "end" and end["code"] == "e2ee_not_paired"

                # The client cancels a channel.
                await tunnel.handle({"t": "end", "route": _route(device_id, "c2")})
                assert tunnel.open_channels == 0

                # Another user's device is never opened.
                stranger = TunnelSession(
                    user_id="someone_else",
                    store=app.state.store,
                    mesh=app.state.device_mesh,
                    hub=app.state.device_link_hub,
                    send=frames.put,
                )
                await stranger.handle({"t": "tun", "route": _route(device_id), "n": 0, "ct": "x"})
                assert (await asyncio.wait_for(frames.get(), 10))["code"] == "connector_offline"
                assert device.state.calls.count("secure.channel") == 3
            finally:
                await tunnel.close()
                await device.stop()

            await eventually(lambda: offline(app.state.rpc, device_id))
            await tunnel.handle({"t": "tun", "route": _route(device_id), "n": 0, "ct": "x"})
            assert (await asyncio.wait_for(frames.get(), 10))["code"] == "connector_offline"

    asyncio.run(scenario())


def test_tunnel_socket_needs_a_ticket_and_well_formed_frames() -> None:
    from conftest import make_test_client
    from starlette.websockets import WebSocketDisconnect

    from agent_server.core.auth import create_user_access_token

    with make_test_client() as client:
        store = client.app.state.store
        user = client.portal.call(lambda: store.create_user(user_id="user_tun", password="password-tun"))
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        device_id = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()["connector"]["id"]

        def ticket() -> str:
            return client.post(
                "/ws-ticket", headers=headers, json={"clientId": "web_tun", "scope": {"dashboard": True}}
            ).json()["ticket"]

        try:
            with client.websocket_connect("/api/v3/tunnel?ticket=nope") as ws:
                ws.receive_json()
        except WebSocketDisconnect as exc:
            assert exc.code == 1008
        else:
            raise AssertionError("a bad ticket was accepted")

        with client.websocket_connect(f"/api/v3/tunnel?ticket={ticket()}") as ws:
            # The device has no link: the channel ends at once.
            ws.send_json({"t": "tun", "route": _route(device_id), "n": 0, "ct": "x"})
            assert ws.receive_json() == {"t": "end", "route": _route(device_id), "code": "connector_offline"}
            # Not a client id: the socket is closed.
            ws.send_json({"t": "tun", "route": {**_route(device_id), "clientId": "web_1"}, "n": 0, "ct": "x"})
            try:
                ws.receive_json()
            except WebSocketDisconnect as exc:
                assert exc.code == 1008
            else:
                raise AssertionError("a malformed route was accepted")
