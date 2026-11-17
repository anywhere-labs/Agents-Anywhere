"""Runtime status reports are bound to the connection that sent them."""

from __future__ import annotations

import asyncio
from typing import Any

from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app
from agent_server.core.device_runtime import RuntimeDiscoveryResponse
from test_runtime_instances_lifecycle import _v2_discovery

ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.messages.append(message)


def _make_connector(tmp_path: Any) -> tuple[TestClient, str, str]:
    app: Any = create_app()
    client = TestClient(app)
    config = client.get("/auth/config").json()
    registration: dict[str, Any] = {
        "email": f"{ADMIN_USER}@example.com",
        "displayName": ADMIN_USER,
        "password": ADMIN_PASSWORD,
    }
    if config["needsBootstrap"]:
        registration["setupToken"] = client.app.state.setup_token.peek()
    registered = client.post("/auth/register", json=registration)
    assert registered.status_code == 200, registered.text
    headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}

    created = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert created.status_code == 200, created.text
    connector = created.json()
    connector_id = connector["connector"]["id"]
    authenticated = client.post(
        "/connector/auth",
        headers={
            "Authorization": (f"Connector {connector_id}:{connector['connectorToken']}")
        },
    )
    assert authenticated.status_code == 200, authenticated.text
    return client, connector_id, authenticated.json()["accessToken"]


async def _seed_named(
    client: TestClient, connector_id: str, *, active: bool = False
) -> str:
    store = client.app.state.store
    await store.replace_connector_runtime_types(
        connector_id,
        RuntimeDiscoveryResponse.model_validate(_v2_discovery()).runtimeTypes,
    )
    runtime = await store.create_device_runtime(
        connector_id,
        runtime_type="codex",
        name="Work Codex",
        config={"home": "/work"},
        active=active,
    )
    return runtime["runtimeId"]


def test_stale_connection_status_cannot_overwrite_current_instance(
    tmp_path: Any,
) -> None:
    client, connector_id, _ = _make_connector(tmp_path)

    async def exercise() -> None:
        manager = client.app.state.rpc
        service = client.app.state.device_runtime_service
        runtime_id = await _seed_named(client, connector_id)
        old = await manager.register(connector_id, FakeWebSocket())
        assert await manager.unregister(connector_id, old)
        current = await manager.register(connector_id, FakeWebSocket())
        ignored = await service.apply_status(
            connector_id,
            runtime_id,
            "error",
            error={"code": "stale"},
            expected_connection_id=old.connection_id,
        )
        assert ignored is None
        applied = await service.apply_status(
            connector_id,
            runtime_id,
            "running",
            expected_connection_id=current.connection_id,
        )
        assert applied is not None and applied.status == "running"
        assert applied.error is None
        assert await manager.unregister(connector_id, current)

    asyncio.run(exercise())
