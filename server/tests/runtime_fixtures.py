"""Provider descriptors and persisted instances for runtime service tests."""

from typing import Any

from sqlalchemy import insert

from agent_server.core.device_runtime import RuntimeDiscoveryResponse
from agent_server.infra.db import device_runtimes


def describe_inventory(inventory: dict[str, Any]) -> RuntimeDiscoveryResponse:
    descriptors = []
    for item in inventory["runtimes"]:
        schema = item.get("schema")
        available = item.get("status") != "unavailable"
        descriptors.append(
            {
                "runtimeType": item["runtimeId"],
                "implementationType": item.get("runtimeType"),
                "displayName": item["displayName"],
                "description": None,
                "available": available,
                "reason": None if available else "Fixture provider unavailable",
                "recommended": False,
                "recommendationRank": None,
                "configSchema": None
                if schema is None
                else {
                    "revision": 1,
                    "schema": schema,
                    "uiSchema": item.get("uiSchema"),
                    "defaults": item.get("defaults", {}),
                    "metadata": {},
                },
                "capabilities": item.get("capabilities", {}),
                "metadata": item.get("metadata", {}),
                "instancePolicy": "single",
                "maxInstances": 1,
            }
        )
    return RuntimeDiscoveryResponse.model_validate({"runtimeTypes": descriptors})


async def seed_runtime_inventory(
    store: Any, connector_id: str, inventory: dict[str, Any]
) -> None:
    """Seed existing type-equal IDs explicitly; discovery never creates them."""
    discovery = describe_inventory(inventory)
    await store.replace_connector_runtime_types(connector_id, discovery.runtimeTypes)
    async with store._engine.begin() as connection:
        for item in inventory["runtimes"]:
            await connection.execute(
                insert(device_runtimes).values(
                    connector_id=connector_id,
                    runtime_id=item["runtimeId"],
                    runtime_type=item["runtimeId"],
                    name=item["displayName"],
                    name_key=item["displayName"].casefold(),
                    config_json=None,
                    active=0,
                    status=item.get("status", "stopped"),
                    error_json=None,
                    created_at="2026-09-08T00:00:00Z",
                    updated_at="2026-09-08T00:00:00Z",
                )
            )
