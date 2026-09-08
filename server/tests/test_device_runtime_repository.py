from __future__ import annotations

import asyncio

from agent_server.core.device_runtime import RuntimeDiscoveryResponse
from test_runtime_instances_lifecycle import _make_client, _v2_discovery


def test_discovery_preserves_instance_owned_state_without_negotiation(tmp_path):
    client, _, connector_id, _ = _make_client(tmp_path, _v2_discovery())
    store = client.app.state.store

    async def run():
        discovery = RuntimeDiscoveryResponse.model_validate(_v2_discovery())
        await store.replace_connector_runtime_types(
            connector_id, discovery.runtimeTypes
        )
        created = await store.create_device_runtime(
            connector_id,
            runtime_type="codex",
            name="Work Codex",
            config={"home": "/work"},
            active=True,
        )
        runtime_id = created["runtimeId"]
        await store.set_device_runtime_status(
            connector_id, runtime_id, "error", error={"code": "start_failed"}
        )
        descriptor = discovery.runtimeTypes[0].model_copy(
            update={"displayName": "Updated provider"}
        )
        await store.replace_connector_runtime_types(connector_id, [descriptor])
        refreshed = await store.get_device_runtime(connector_id, runtime_id)
        assert refreshed["name"] == "Work Codex"
        assert refreshed["config"] == {"home": "/work"}
        assert refreshed["active"] is True
        assert refreshed["status"] == "error"
        assert refreshed["error"] == {"code": "start_failed"}
        await store.replace_connector_runtime_types(connector_id, [])
        missing = await store.get_device_runtime(connector_id, runtime_id)
        assert missing["present"] is False
        assert missing["config"] == {"home": "/work"}
        assert missing["name"] == "Work Codex"

    asyncio.run(run())
