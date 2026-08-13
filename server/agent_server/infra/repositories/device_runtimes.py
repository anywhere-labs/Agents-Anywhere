from __future__ import annotations

import json
from typing import Any

from sqlalchemy import case, insert, select, update
from sqlalchemy.exc import IntegrityError

from agent_server.core.device_runtime import RuntimeTypeDescriptor
from agent_server.core.runtime_identity import runtime_instance_name_key
from agent_server.core.utc import utc_now
from agent_server.infra.db import connector_runtime_types as runtime_types_t
from agent_server.infra.db import connectors as connectors_t
from agent_server.infra.db import device_runtimes as device_runtimes_t


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_loads(value: str | None) -> Any:
    if value is None:
        return None
    return json.loads(value)


class DeviceRuntimeRepositoryMixin:
    async def replace_connector_runtime_types(
        self,
        connector_id: str,
        runtime_types: list[RuntimeTypeDescriptor],
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
                update(runtime_types_t)
                .where(runtime_types_t.c.connector_id == connector_id)
                .values(
                    available=0,
                    recommended=0,
                    recommendation_rank=None,
                    last_discovered_at=now,
                    updated_at=now,
                )
            )

            for runtime_type in runtime_types:
                existing = (
                    await conn.execute(
                        select(runtime_types_t.c.runtime_type).where(
                            runtime_types_t.c.connector_id == connector_id,
                            runtime_types_t.c.runtime_type
                            == runtime_type.runtimeType,
                        )
                    )
                ).first()
                values = {
                    "display_name": runtime_type.displayName,
                    "description": runtime_type.description,
                    "available": 1 if runtime_type.available else 0,
                    "recommended": 1 if runtime_type.recommended else 0,
                    "recommendation_rank": runtime_type.recommendationRank,
                    "discovery_json": _json_dumps(runtime_type.discovery),
                    "config_schema_json": (
                        _json_dumps(runtime_type.schema_)
                        if runtime_type.schema_ is not None
                        else None
                    ),
                    "ui_schema_json": (
                        _json_dumps(runtime_type.uiSchema)
                        if runtime_type.uiSchema is not None
                        else None
                    ),
                    "defaults_json": _json_dumps(runtime_type.defaults),
                    "capabilities_json": _json_dumps(runtime_type.capabilities),
                    "metadata_json": _json_dumps(runtime_type.metadata),
                    "last_discovered_at": now,
                    "updated_at": now,
                }
                if existing is None:
                    await conn.execute(
                        insert(runtime_types_t).values(
                            connector_id=connector_id,
                            runtime_type=runtime_type.runtimeType,
                            **values,
                        )
                    )
                else:
                    await conn.execute(
                        update(runtime_types_t)
                        .where(
                            runtime_types_t.c.connector_id == connector_id,
                            runtime_types_t.c.runtime_type
                            == runtime_type.runtimeType,
                        )
                        .values(**values)
                    )
        return await self.list_connector_runtime_types(connector_id)

    async def list_connector_runtime_types(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = (
            select(runtime_types_t)
            .join(connectors_t, connectors_t.c.id == runtime_types_t.c.connector_id)
            .where(
                runtime_types_t.c.connector_id == connector_id,
                connectors_t.c.revoked == 0,
            )
            .order_by(
                runtime_types_t.c.recommended.desc(),
                case(
                    (runtime_types_t.c.recommendation_rank.is_(None), 1),
                    else_=0,
                ),
                runtime_types_t.c.recommendation_rank,
                runtime_types_t.c.display_name,
                runtime_types_t.c.runtime_type,
            )
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
            if not rows and not await self._connector_exists(
                conn, connector_id, user_id=user_id
            ):
                raise KeyError(connector_id)
        return [_runtime_type_row(row) for row in rows]

    async def get_connector_runtime_type(
        self,
        connector_id: str,
        runtime_type: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        query = (
            select(runtime_types_t)
            .join(connectors_t, connectors_t.c.id == runtime_types_t.c.connector_id)
            .where(
                runtime_types_t.c.connector_id == connector_id,
                runtime_types_t.c.runtime_type == runtime_type,
                connectors_t.c.revoked == 0,
            )
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(runtime_type)
        return _runtime_type_row(row)

    async def create_device_runtime(
        self,
        connector_id: str,
        *,
        runtime_id: str,
        runtime_type: str,
        name: str,
        config: dict[str, Any] | None,
        active: bool,
    ) -> dict[str, Any]:
        now = utc_now()
        async with self._engine.begin() as conn:
            runtime_type_row = (
                await conn.execute(
                    select(runtime_types_t.c.runtime_type).where(
                        runtime_types_t.c.connector_id == connector_id,
                        runtime_types_t.c.runtime_type == runtime_type,
                    )
                )
            ).first()
            if runtime_type_row is None:
                raise KeyError(runtime_type)
            try:
                await conn.execute(
                    insert(device_runtimes_t).values(
                        connector_id=connector_id,
                        runtime_id=runtime_id,
                        runtime_type=runtime_type,
                        name=name,
                        name_key=runtime_instance_name_key(name),
                        config_json=(
                            _json_dumps(config) if config is not None else None
                        ),
                        active=1 if active else 0,
                        status="stopped",
                        error_json=None,
                        created_at=now,
                        updated_at=now,
                    )
                )
            except IntegrityError as exc:
                raise ValueError("runtime instance ID or name already exists") from exc
        return await self.get_device_runtime(connector_id, runtime_id)

    async def rename_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        name: str,
    ) -> dict[str, Any]:
        try:
            return await self._update_device_runtime(
                connector_id,
                runtime_id,
                name=name,
                name_key=runtime_instance_name_key(name),
            )
        except IntegrityError as exc:
            raise ValueError("runtime instance name already exists") from exc

    async def list_device_runtimes(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = _runtime_instance_select().where(
            device_runtimes_t.c.connector_id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        query = query.order_by(
            device_runtimes_t.c.name_key, device_runtimes_t.c.runtime_id
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
            if not rows and not await self._connector_exists(
                conn, connector_id, user_id=user_id
            ):
                raise KeyError(connector_id)
        return [_runtime_instance_row(row) for row in rows]

    async def get_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        query = _runtime_instance_select().where(
            device_runtimes_t.c.connector_id == connector_id,
            device_runtimes_t.c.runtime_id == runtime_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(runtime_id)
        return _runtime_instance_row(row)

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

    @staticmethod
    async def _connector_exists(
        conn: Any,
        connector_id: str,
        *,
        user_id: str | None,
    ) -> bool:
        query = select(connectors_t.c.id).where(
            connectors_t.c.id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        return (await conn.execute(query)).first() is not None


def _runtime_instance_select() -> Any:
    return (
        select(
            device_runtimes_t,
            runtime_types_t.c.display_name.label("type_display_name"),
            runtime_types_t.c.available.label("type_available"),
            runtime_types_t.c.config_schema_json.label("type_config_schema_json"),
            runtime_types_t.c.ui_schema_json.label("type_ui_schema_json"),
            runtime_types_t.c.defaults_json.label("type_defaults_json"),
            runtime_types_t.c.capabilities_json.label("type_capabilities_json"),
        )
        .join(
            runtime_types_t,
            (runtime_types_t.c.connector_id == device_runtimes_t.c.connector_id)
            & (runtime_types_t.c.runtime_type == device_runtimes_t.c.runtime_type),
        )
        .join(connectors_t, connectors_t.c.id == device_runtimes_t.c.connector_id)
    )


def _runtime_type_row(row: Any) -> dict[str, Any]:
    return {
        "connectorId": str(row["connector_id"]),
        "runtimeType": str(row["runtime_type"]),
        "displayName": str(row["display_name"]),
        "description": row["description"],
        "available": bool(row["available"]),
        "recommended": bool(row["recommended"]),
        "recommendationRank": row["recommendation_rank"],
        "discovery": _json_loads(row["discovery_json"]) or {},
        "schema": _json_loads(row["config_schema_json"]),
        "uiSchema": _json_loads(row["ui_schema_json"]) or {},
        "defaults": _json_loads(row["defaults_json"]) or {},
        "capabilities": _json_loads(row["capabilities_json"]) or {},
        "metadata": _json_loads(row["metadata_json"]) or {},
        "lastDiscoveredAt": str(row["last_discovered_at"]),
        "updatedAt": str(row["updated_at"]),
    }


def _runtime_instance_row(row: Any) -> dict[str, Any]:
    name = str(row["name"])
    return {
        "connectorId": str(row["connector_id"]),
        "runtimeId": str(row["runtime_id"]),
        "runtimeType": str(row["runtime_type"]),
        "name": name,
        "displayName": name,
        "typeDisplayName": str(row["type_display_name"]),
        "configured": row["config_json"] is not None,
        "active": bool(row["active"]),
        "status": str(row["status"]),
        "config": _json_loads(row["config_json"]),
        "error": _json_loads(row["error_json"]),
        "available": bool(row["type_available"]),
        "schema": _json_loads(row["type_config_schema_json"]),
        "uiSchema": _json_loads(row["type_ui_schema_json"]) or {},
        "defaults": _json_loads(row["type_defaults_json"]) or {},
        "capabilities": _json_loads(row["type_capabilities_json"]) or {},
        "createdAt": str(row["created_at"]),
        "updatedAt": str(row["updated_at"]),
    }
