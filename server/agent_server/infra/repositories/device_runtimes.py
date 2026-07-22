from __future__ import annotations

import json
from typing import Any

from sqlalchemy import insert, or_, select, update

from agent_server.core.device_runtime import RuntimeInventoryItem
from agent_server.core.utc import utc_now
from agent_server.infra.db import connectors as connectors_t
from agent_server.infra.db import device_runtimes as device_runtimes_t


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_loads(value: str | None) -> Any:
    if value is None:
        return None
    return json.loads(value)


class DeviceRuntimeRepositoryMixin:
    async def replace_device_runtime_inventory(
        self,
        connector_id: str,
        runtimes: list[RuntimeInventoryItem],
    ) -> list[dict[str, Any]]:
        now = utc_now()
        async with self._engine.begin() as conn:
            connector = (
                await conn.execute(
                    select(connectors_t.c.id).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if connector is None:
                raise KeyError(connector_id)

            await conn.execute(
                update(device_runtimes_t)
                .where(device_runtimes_t.c.connector_id == connector_id)
                .values(present=0, updated_at=now)
            )

            for runtime in runtimes:
                existing = (
                    await conn.execute(
                        select(device_runtimes_t.c.runtime_id).where(
                            device_runtimes_t.c.connector_id == connector_id,
                            device_runtimes_t.c.runtime_id == runtime.runtimeId,
                        )
                    )
                ).first()
                values = {
                    "runtime_type": runtime.runtimeType,
                    "display_name": runtime.displayName,
                    "present": 1,
                    "discovery_json": _json_dumps(runtime.discovery),
                    "config_schema_json": _json_dumps(runtime.schema_),
                    "ui_schema_json": _json_dumps(runtime.uiSchema),
                    "status": runtime.status,
                    "last_discovered_at": now,
                    "updated_at": now,
                }
                if existing is None:
                    await conn.execute(
                        insert(device_runtimes_t).values(
                            connector_id=connector_id,
                            runtime_id=runtime.runtimeId,
                            config_json=None,
                            active=0,
                            error_json=None,
                            **values,
                        )
                    )
                else:
                    await conn.execute(
                        update(device_runtimes_t)
                        .where(
                            device_runtimes_t.c.connector_id == connector_id,
                            device_runtimes_t.c.runtime_id == runtime.runtimeId,
                        )
                        .values(**values)
                    )
        return await self.list_device_runtimes(connector_id)

    async def list_device_runtimes(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = (
            select(device_runtimes_t)
            .join(connectors_t, connectors_t.c.id == device_runtimes_t.c.connector_id)
            .where(
                device_runtimes_t.c.connector_id == connector_id,
                connectors_t.c.revoked == 0,
                or_(device_runtimes_t.c.present == 1, device_runtimes_t.c.config_json.is_not(None)),
            )
            .order_by(device_runtimes_t.c.display_name, device_runtimes_t.c.runtime_id)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        if not rows:
            exists_query = select(connectors_t.c.id).where(
                connectors_t.c.id == connector_id,
                connectors_t.c.revoked == 0,
            )
            if user_id is not None:
                exists_query = exists_query.where(connectors_t.c.user_id == user_id)
            async with self._engine.connect() as conn:
                if (await conn.execute(exists_query)).first() is None:
                    raise KeyError(connector_id)
        return [_runtime_row(row) for row in rows]

    async def get_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        query = (
            select(device_runtimes_t)
            .join(connectors_t, connectors_t.c.id == device_runtimes_t.c.connector_id)
            .where(
                device_runtimes_t.c.connector_id == connector_id,
                device_runtimes_t.c.runtime_id == runtime_id,
                connectors_t.c.revoked == 0,
            )
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(runtime_id)
        return _runtime_row(row)

    async def set_device_runtime_config(
        self,
        connector_id: str,
        runtime_id: str,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._update_device_runtime(
            connector_id,
            runtime_id,
            config_json=_json_dumps(config),
            error_json=None,
        )

    async def set_device_runtime_active(
        self,
        connector_id: str,
        runtime_id: str,
        active: bool,
    ) -> dict[str, Any]:
        return await self._update_device_runtime(
            connector_id,
            runtime_id,
            active=1 if active else 0,
        )

    async def set_device_runtime_status(
        self,
        connector_id: str,
        runtime_id: str,
        status: str,
        *,
        error: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._update_device_runtime(
            connector_id,
            runtime_id,
            status=status,
            error_json=_json_dumps(error) if error is not None else None,
        )

    async def clear_device_runtime_config(
        self,
        connector_id: str,
        runtime_id: str,
    ) -> dict[str, Any]:
        return await self._update_device_runtime(
            connector_id,
            runtime_id,
            config_json=None,
            active=0,
            status="stopped",
            error_json=None,
        )

    async def _update_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        **values: Any,
    ) -> dict[str, Any]:
        values["updated_at"] = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(device_runtimes_t)
                .where(
                    device_runtimes_t.c.connector_id == connector_id,
                    device_runtimes_t.c.runtime_id == runtime_id,
                )
                .values(**values)
            )
            if result.rowcount == 0:
                raise KeyError(runtime_id)
        return await self.get_device_runtime(connector_id, runtime_id)


def _runtime_row(row: Any) -> dict[str, Any]:
    return {
        "connectorId": str(row["connector_id"]),
        "runtimeId": str(row["runtime_id"]),
        "runtimeType": str(row["runtime_type"]),
        "displayName": str(row["display_name"]),
        "present": bool(row["present"]),
        "configured": row["config_json"] is not None,
        "active": bool(row["active"]),
        "status": str(row["status"]),
        "discovery": _json_loads(row["discovery_json"]) or {},
        "schema": _json_loads(row["config_schema_json"]),
        "uiSchema": _json_loads(row["ui_schema_json"]) or {},
        "config": _json_loads(row["config_json"]),
        "error": _json_loads(row["error_json"]),
        "lastDiscoveredAt": str(row["last_discovered_at"]),
        "updatedAt": str(row["updated_at"]),
    }
