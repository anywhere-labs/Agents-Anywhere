from __future__ import annotations

import asyncio

from sqlalchemy import insert

from agent_server.core.device_runtime import RuntimeInventoryItem
from agent_server.infra.db import connectors
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store


def test_legacy_inventory_preserves_instance_owned_state(tmp_path) -> None:
    path = tmp_path / "runtime-repository.sqlite3"
    upgrade_database(db_url=f"sqlite+aiosqlite:///{path}")
    store = Store(path)
    try:
        asyncio.run(_insert_connector(store, "conn_runtime_repository"))
        initial = _dsh_inventory(
            display_name="DSH Host",
            status="stopped",
            endpoint="/tmp/dsh-1.sock",
        )

        listed = asyncio.run(
            store.replace_device_runtime_inventory(
                "conn_runtime_repository",
                [initial],
            )
        )

        assert listed[0]["runtimeId"] == "dsh"
        assert listed[0]["runtimeType"] == "dsh"
        assert listed[0]["displayName"] == "DSH Host"
        assert listed[0]["metadata"] == {
            "bridgeVersion": "0.1.0",
            "storageMode": "local",
        }
        asyncio.run(
            store.set_device_runtime_config(
                "conn_runtime_repository",
                "dsh",
                {"endpoint": "/tmp/desired.sock"},
            )
        )
        asyncio.run(
            store.set_device_runtime_active(
                "conn_runtime_repository",
                "dsh",
                True,
            )
        )
        asyncio.run(
            store.set_device_runtime_status(
                "conn_runtime_repository",
                "dsh",
                "error",
                error={"code": "start_failed"},
            )
        )

        refreshed = _dsh_inventory(
            display_name="Discovery Label Changed",
            status="available",
            endpoint="/tmp/dsh-2.sock",
        )
        asyncio.run(
            store.replace_device_runtime_inventory(
                "conn_runtime_repository",
                [refreshed],
            )
        )

        instance = asyncio.run(
            store.get_device_runtime("conn_runtime_repository", "dsh")
        )
        assert instance["displayName"] == "DSH Host"
        assert instance["config"] == {"endpoint": "/tmp/desired.sock"}
        assert instance["active"] is True
        assert instance["status"] == "error"
        assert instance["error"] == {"code": "start_failed"}
        assert instance["discovery"] == {"endpoint": "/tmp/dsh-2.sock"}

        runtime_type = asyncio.run(
            store.get_connector_runtime_type("conn_runtime_repository", "dsh")
        )
        assert runtime_type["runtimeType"] == "dsh"
        assert runtime_type["implementationType"] == "local-service"
        assert runtime_type["displayName"] == "Discovery Label Changed"
        assert runtime_type["instancePolicy"] == "single"
        assert runtime_type["maxInstances"] == 1
        assert runtime_type["defaults"] == {"endpoint": "/tmp/default.sock"}
        assert runtime_type["capabilities"] == {"modelCatalog": True}

        cleared = asyncio.run(
            store.clear_device_runtime_config("conn_runtime_repository", "dsh")
        )
        assert cleared["displayName"] == "DSH Host"
        assert cleared["configured"] is False
        assert cleared["active"] is False
        assert cleared["status"] == "stopped"
        assert cleared["error"] is None

        asyncio.run(
            store.replace_device_runtime_inventory("conn_runtime_repository", [])
        )
        assert asyncio.run(store.list_device_runtimes("conn_runtime_repository")) == []
        preserved = asyncio.run(
            store.get_device_runtime("conn_runtime_repository", "dsh")
        )
        assert preserved["runtimeId"] == "dsh"
        assert preserved["present"] is False
        assert preserved["configured"] is False
    finally:
        asyncio.run(store.close())


async def _insert_connector(store: Store, connector_id: str) -> None:
    now = "2026-08-25T00:00:00Z"
    async with store.engine.begin() as connection:
        await connection.execute(
            insert(connectors).values(
                id=connector_id,
                user_id="user_runtime_repository",
                name="Runtime repository",
                status="offline",
                token_hash="hash",
                token_prefix="cxt_",
                revoked=0,
                created_at=now,
                updated_at=now,
            )
        )


def _dsh_inventory(
    *,
    display_name: str,
    status: str,
    endpoint: str,
) -> RuntimeInventoryItem:
    return RuntimeInventoryItem.model_validate(
        {
            "runtimeId": "dsh",
            "runtimeType": "local-service",
            "displayName": display_name,
            "discovery": {"endpoint": endpoint},
            "schema": {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
            },
            "uiSchema": {"endpoint": {"component": "path"}},
            "defaults": {"endpoint": "/tmp/default.sock"},
            "status": status,
            "capabilities": {"modelCatalog": True},
            "metadata": {
                "bridgeVersion": "0.1.0",
                "storageMode": "local",
                "privatePath": "/must/not/escape",
            },
        }
    )
