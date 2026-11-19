"""The Router enforces a scoped encrypted tunnel to the device."""

import asyncio

import pytest
from meshcall import Mesh, MeshCallError, Router
from mesh_fixtures import RouterProcess

from agent_server.core.device_content import CONTENT_SERVICE, ContentRequest, ContentResult
from device_link_helpers import server, user_and_device
from scripts.v3_fake_device import Empty, connect_device


def test_content_tunnel_reaches_only_the_device_service(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _, device_id, token = await user_and_device(app, client)
            device, _, _ = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                issuer = app.state.device_mesh
                key = device.e2ee_key.public_key
                ticket = await issuer.open_content_tunnel(device_id, key, "test-login")
                assert ticket.credential.startswith("mtun_e2e.")
                assert not any(getattr(route, "path", None) == "/api/v3/tunnel" for route in app.routes)
                async with Mesh(Router(mesh_router.url), tunnel=ticket.credential, e2e_key=key) as peer:
                    request = ContentRequest(method="POST", path="/api/v2/sessions/qa", body={"test": "inside the tunnel"})

                    async def send() -> ContentResult:
                        return await peer.call_unary(
                            CONTENT_SERVICE, "request", request, ContentResult, instance=device_id, timeout=5,
                        )

                    response = await send()
                    assert response.status == 200 and response.body == request.body
                    with pytest.raises(MeshCallError) as out_of_scope:
                        await peer.call_unary("aa.device.v1.Commands", "status", Empty(), Empty(), instance=device_id, timeout=5)
                    assert out_of_scope.value.code == "permission_denied"

                    await issuer.revoke_content_tunnel(ticket.tunnel_id)
                    with pytest.raises(MeshCallError):
                        await send()
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_required_link_refuses_a_connector_without_an_encryption_key(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _, device_id, token = await user_and_device(app, client)
            auth = await client.post(
                "/api/v3/device/auth", headers={"Authorization": f"Connector {device_id}:{token}"},
            )
            auth.raise_for_status()
            hello = await client.post(
                "/api/v3/device/hello",
                headers={"Authorization": "Bearer " + auth.json()["accessToken"]},
                json={
                    "deviceId": device_id, "connectorVersion": "3.0.0", "contractVersions": ["1.0"],
                    "os": "macos", "host": "cli",
                },
            )
            assert hello.status_code == 409
            assert hello.json()["detail"]["code"] == "encrypted_link_required"
            assert await app.state.device_link.link_record(device_id) is None

    asyncio.run(scenario())
