"""Provider descriptors and persisted instances for runtime service tests."""

from typing import Any

from sqlalchemy.dialects.postgresql import insert

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
                ).on_conflict_do_nothing()
            )


async def seed_workspace_project(store, connector_id, user_id, cwd="/repo", runtime="codex", name="Fixture project", native_id=None, runtime_id=None, member_ids=()):
    """Project unrelated API tests through the authoritative source inventory."""
    import hashlib
    import json
    from datetime import UTC, datetime

    from sqlalchemy import select, update
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from agent_server.core.workspace_inventory import RuntimeWorkspaceInventory
    from agent_server.infra.db import (
        connector_runtime_types,
        connectors,
        projects,
        runtime_workspace_inventories,
        sessions,
    )

    now = datetime.now(UTC).isoformat()
    runtime_id = runtime_id or runtime
    async with store._engine.begin() as conn:
        await conn.execute(pg_insert(connector_runtime_types).values(
            connector_id=connector_id, runtime_type=runtime, implementation_type=runtime,
            display_name=runtime, discovery_json="{}", defaults_json="{}", capabilities_json="{}",
            metadata_json="{}", instance_policy="single", max_instances=1,
            last_discovered_at=now, created_at=now, updated_at=now,
        ).on_conflict_do_nothing())
        await conn.execute(pg_insert(device_runtimes).values(
            connector_id=connector_id, runtime_id=runtime_id, runtime_type=runtime, name=runtime_id,
            name_key=runtime_id, config_json="{}", active=1, status="running", created_at=now, updated_at=now,
        ).on_conflict_do_nothing())
        await conn.execute(update(device_runtimes).where(
            device_runtimes.c.connector_id == connector_id, device_runtimes.c.runtime_id == runtime_id,
            device_runtimes.c.config_json.is_(None),
        ).values(config_json="{}"))
        epoch = (await conn.execute(select(connectors.c.workspace_epoch).where(connectors.c.id == connector_id))).scalar_one()
        prior = (await conn.execute(select(runtime_workspace_inventories.c.snapshot_json).where(
            runtime_workspace_inventories.c.connector_id == connector_id,
            runtime_workspace_inventories.c.runtime_id == runtime_id,
        ))).scalar_one_or_none()
        fixture_members = (await conn.execute(select(sessions.c.external_session_id, sessions.c.cwd, projects.c.native_project_id)
            .join(projects, projects.c.id == sessions.c.project_id).where(
                sessions.c.connector_id == connector_id, sessions.c.runtime_id == runtime_id,
                sessions.c.external_session_id.is_not(None), projects.c.native_project_id.is_not(None),
            ))).all()
    if not epoch:
        epoch = await store.issue_workspace_epoch(connector_id)
    snapshot = json.loads(prior) if prior else {}
    native_id = native_id or "fixture-" + hashlib.sha256(cwd.encode()).hexdigest()[:16]
    workspaces = [{"id": wid, "title": w["title"], "path": w["path"], "roots": w["roots"], "identityKind": w["identityKind"]}
                  for wid, w in snapshot.get("workspaces", {}).items() if wid != native_id]
    workspaces.append({"id": native_id, "title": name, "path": cwd, "roots": [cwd]})
    directories = [{"path": path, "state": state} for path, state in snapshot.get("directories", {}).items() if path != cwd]
    directories.append({"path": cwd, "state": "present"})
    members = {**snapshot.get("members", {})}
    members.update({row.external_session_id: {"projectId": row.native_project_id, "cwd": row.cwd} for row in fixture_members})
    members.update({sid: {"projectId": native_id, "cwd": cwd} for sid in member_ids})
    sequence = snapshot.get("sequence", 0) + 1
    await store.sync_runtime_workspaces(connector_id=connector_id, runtime_id=runtime_id, runtime=runtime,
        inventory=RuntimeWorkspaceInventory.model_validate({"version": 2, "epoch": epoch, "sequence": sequence,
            "snapshotId": f"fixture-{sequence}", "observedAt": now, "catalogComplete": True, "membersComplete": True,
            "workspaces": workspaces, "members": [{"sessionId": sid, **member} for sid, member in members.items()], "directories": directories}))
    return next(p for p in await store.list_projects(user_id=user_id)
                if p.connectorId == connector_id and p.runtimeId == runtime_id and p.nativeProjectId == native_id)
