from __future__ import annotations

import json
from typing import Any

from sqlalchemy import case, func, insert, or_, select, update
from sqlalchemy.exc import IntegrityError

from agent_server.core.device_runtime import RuntimeInventoryItem, RuntimeTypeDescriptor
from agent_server.core.runtime_identity import (
    RuntimeIdentity,
    RuntimeIdentityError,
    generate_runtime_instance_id,
    normalize_runtime_instance_name,
    runtime_instance_name_key,
)
from agent_server.core.utc import utc_now
from agent_server.infra.db import connector_runtime_types as runtime_types_t
from agent_server.infra.db import connectors as connectors_t
from agent_server.infra.db import device_runtimes as device_runtimes_t

_CONTROL_V2_DESCRIPTOR_KEY = "__runtimeControlV2Descriptor"


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
        """Persist Runtime Control 2.0 type facts without creating instances."""

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
                    present=0,
                    available=0,
                    reason="not_discovered",
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
                            runtime_types_t.c.runtime_type == runtime_type.runtimeType,
                        )
                    )
                ).first()
                config_schema = runtime_type.configSchema
                values = {
                    # The v2_14 column is non-nullable. Keep the exact nullable
                    # value in the descriptor envelope and use the provider key
                    # only as the physical fallback.
                    "implementation_type": (
                        runtime_type.implementationType or runtime_type.runtimeType
                    ),
                    "display_name": runtime_type.displayName,
                    "description": runtime_type.description,
                    "present": 1,
                    "available": 1 if runtime_type.available else 0,
                    "reason": runtime_type.reason,
                    "recommended": 1 if runtime_type.recommended else 0,
                    "recommendation_rank": runtime_type.recommendationRank,
                    "discovery_json": _json_dumps(
                        {
                            _CONTROL_V2_DESCRIPTOR_KEY: runtime_type.model_dump(
                                mode="json",
                                by_alias=True,
                            )
                        }
                    ),
                    "config_schema_json": (
                        _json_dumps(config_schema.schema_)
                        if config_schema is not None
                        else None
                    ),
                    "ui_schema_json": (
                        _json_dumps(config_schema.uiSchema)
                        if config_schema is not None
                        and config_schema.uiSchema is not None
                        else None
                    ),
                    "defaults_json": _json_dumps(
                        config_schema.defaults if config_schema is not None else {}
                    ),
                    "capabilities_json": _json_dumps(runtime_type.capabilities),
                    "metadata_json": _json_dumps(runtime_type.metadata),
                    "instance_policy": runtime_type.instancePolicy,
                    "max_instances": runtime_type.maxInstances,
                    "last_discovered_at": now,
                    "updated_at": now,
                }
                if existing is None:
                    await conn.execute(
                        insert(runtime_types_t).values(
                            connector_id=connector_id,
                            runtime_type=runtime_type.runtimeType,
                            created_at=now,
                            **values,
                        )
                    )
                else:
                    await conn.execute(
                        update(runtime_types_t)
                        .where(
                            runtime_types_t.c.connector_id == connector_id,
                            runtime_types_t.c.runtime_type == runtime_type.runtimeType,
                        )
                        .values(**values)
                    )

            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id)
                .values(runtime_control_version="2.0", updated_at=now)
            )
        return await self.list_connector_runtime_types(connector_id)

    async def replace_device_runtime_inventory(
        self,
        connector_id: str,
        runtimes: list[RuntimeInventoryItem],
        *,
        select_control_version: bool = True,
    ) -> list[dict[str, Any]]:
        """Persist a legacy 1.0 inventory as types plus compatibility instances."""

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
                    present=0,
                    available=0,
                    reason="not_discovered",
                    recommended=0,
                    recommendation_rank=None,
                    last_discovered_at=now,
                    updated_at=now,
                )
            )
            used_name_keys = set(
                (
                    await conn.execute(
                        select(device_runtimes_t.c.name_key).where(
                            device_runtimes_t.c.connector_id == connector_id
                        )
                    )
                ).scalars()
            )

            for runtime in runtimes:
                # In runtime-control 1.0, runtimeId is the provider identity.
                # runtimeType is an implementation category for providers such
                # as DSH ("local-service"), not an instance identity.
                runtime_type = runtime.runtimeId
                available = runtime.status != "unavailable"
                descriptor = (
                    await conn.execute(
                        select(runtime_types_t.c.runtime_type).where(
                            runtime_types_t.c.connector_id == connector_id,
                            runtime_types_t.c.runtime_type == runtime_type,
                        )
                    )
                ).first()
                type_values = {
                    "implementation_type": runtime.runtimeType,
                    "display_name": runtime.displayName,
                    "description": None,
                    "present": 1,
                    "available": 1 if available else 0,
                    "reason": None if available else "runtime_unavailable",
                    "recommended": 0,
                    "recommendation_rank": None,
                    "discovery_json": _json_dumps(runtime.discovery),
                    "config_schema_json": (
                        _json_dumps(runtime.schema_)
                        if runtime.schema_ is not None
                        else None
                    ),
                    "ui_schema_json": (
                        _json_dumps(runtime.uiSchema)
                        if runtime.uiSchema is not None
                        else None
                    ),
                    "defaults_json": _json_dumps(runtime.defaults),
                    "capabilities_json": _json_dumps(runtime.capabilities),
                    "metadata_json": _json_dumps(
                        _public_runtime_metadata(runtime.metadata)
                    ),
                    "instance_policy": "single",
                    "max_instances": 1,
                    "last_discovered_at": now,
                    "updated_at": now,
                }
                if descriptor is None:
                    await conn.execute(
                        insert(runtime_types_t).values(
                            connector_id=connector_id,
                            runtime_type=runtime_type,
                            created_at=now,
                            **type_values,
                        )
                    )
                else:
                    await conn.execute(
                        update(runtime_types_t)
                        .where(
                            runtime_types_t.c.connector_id == connector_id,
                            runtime_types_t.c.runtime_type == runtime_type,
                        )
                        .values(**type_values)
                    )

                instance = (
                    await conn.execute(
                        select(
                            device_runtimes_t.c.runtime_id,
                            device_runtimes_t.c.active,
                        ).where(
                            device_runtimes_t.c.connector_id == connector_id,
                            device_runtimes_t.c.runtime_id == runtime_type,
                        )
                    )
                ).first()
                if instance is None:
                    name = _unique_runtime_name(
                        runtime.displayName,
                        runtime_id=runtime_type,
                        used_name_keys=used_name_keys,
                    )
                    await conn.execute(
                        insert(device_runtimes_t).values(
                            connector_id=connector_id,
                            runtime_id=runtime_type,
                            runtime_type=runtime_type,
                            name=name,
                            name_key=runtime_instance_name_key(name),
                            config_json=None,
                            active=0,
                            status=runtime.status,
                            error_json=None,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                elif not bool(instance.active):
                    await conn.execute(
                        update(device_runtimes_t)
                        .where(
                            device_runtimes_t.c.connector_id == connector_id,
                            device_runtimes_t.c.runtime_id == runtime_type,
                        )
                        .values(status=runtime.status, updated_at=now)
                    )
            if select_control_version:
                await conn.execute(
                    update(connectors_t)
                    .where(connectors_t.c.id == connector_id)
                    .values(runtime_control_version="1.0", updated_at=now)
                )
        return await self.list_device_runtimes(connector_id)

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

    async def get_connector_runtime_control_version(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> str:
        query = select(connectors_t.c.runtime_control_version).where(
            connectors_t.c.id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            value = (await conn.execute(query)).scalar_one_or_none()
        if value is None:
            raise KeyError(connector_id)
        return str(value)

    async def set_connector_runtime_control_version(
        self,
        connector_id: str,
        version: str,
    ) -> None:
        if version not in {"1.0", "2.0"}:
            raise ValueError(f"unsupported runtime control version: {version}")
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
                update(connectors_t)
                .where(connectors_t.c.id == connector_id)
                .values(runtime_control_version=version, updated_at=now)
            )

    async def create_device_runtime(
        self,
        connector_id: str,
        *,
        runtime_type: str,
        name: str,
        config: dict[str, Any],
        active: bool,
    ) -> dict[str, Any]:
        normalized_name = normalize_runtime_instance_name(name)
        runtime_id = str(generate_runtime_instance_id())
        RuntimeIdentity.create(runtime_type=runtime_type, runtime_id=runtime_id)
        now = utc_now()
        try:
            async with self._engine.begin() as conn:
                # This no-op write serializes policy checks on SQLite and locks
                # the type row on PostgreSQL before counting existing instances.
                locked = await conn.execute(
                    update(runtime_types_t)
                    .where(
                        runtime_types_t.c.connector_id == connector_id,
                        runtime_types_t.c.runtime_type == runtime_type,
                    )
                    .values(updated_at=runtime_types_t.c.updated_at)
                )
                if locked.rowcount == 0:
                    raise KeyError(runtime_type)

                type_row = (
                    (
                        await conn.execute(
                            select(
                                runtime_types_t.c.present,
                                runtime_types_t.c.instance_policy,
                                runtime_types_t.c.max_instances,
                                connectors_t.c.runtime_control_version,
                            )
                            .join(
                                connectors_t,
                                connectors_t.c.id == runtime_types_t.c.connector_id,
                            )
                            .where(
                                runtime_types_t.c.connector_id == connector_id,
                                runtime_types_t.c.runtime_type == runtime_type,
                                connectors_t.c.revoked == 0,
                            )
                        )
                    )
                    .mappings()
                    .first()
                )
                if type_row is None:
                    raise KeyError(runtime_type)
                if type_row["runtime_control_version"] != "2.0":
                    raise ValueError("runtime instances are unsupported")
                if not bool(type_row["present"]):
                    raise ValueError(
                        "runtime type is not currently present on the connector"
                    )

                current_count = (
                    await conn.execute(
                        select(func.count())
                        .select_from(device_runtimes_t)
                        .where(
                            device_runtimes_t.c.connector_id == connector_id,
                            device_runtimes_t.c.runtime_type == runtime_type,
                        )
                    )
                ).scalar_one()
                max_instances = (
                    1
                    if type_row["instance_policy"] == "single"
                    else type_row["max_instances"]
                )
                if max_instances is not None and current_count >= max_instances:
                    raise ValueError("runtime instance limit reached")

                await conn.execute(
                    insert(device_runtimes_t).values(
                        connector_id=connector_id,
                        runtime_id=runtime_id,
                        runtime_type=runtime_type,
                        name=normalized_name,
                        name_key=runtime_instance_name_key(normalized_name),
                        config_json=_json_dumps(config),
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
        normalized_name = normalize_runtime_instance_name(name)
        now = utc_now()
        try:
            async with self._engine.begin() as conn:
                instance = (
                    await conn.execute(
                        select(device_runtimes_t.c.runtime_type).where(
                            device_runtimes_t.c.connector_id == connector_id,
                            device_runtimes_t.c.runtime_id == runtime_id,
                        )
                    )
                ).first()
                if instance is None:
                    raise KeyError(runtime_id)
                RuntimeIdentity.create(
                    runtime_type=str(instance.runtime_type),
                    runtime_id=runtime_id,
                )
                await conn.execute(
                    update(device_runtimes_t)
                    .where(
                        device_runtimes_t.c.connector_id == connector_id,
                        device_runtimes_t.c.runtime_id == runtime_id,
                    )
                    .values(
                        name=normalized_name,
                        name_key=runtime_instance_name_key(normalized_name),
                        updated_at=now,
                    )
                )
        except IntegrityError as exc:
            raise ValueError("runtime instance name already exists") from exc
        return await self.get_device_runtime(connector_id, runtime_id)

    async def list_device_runtimes(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = _runtime_instance_select().where(
            device_runtimes_t.c.connector_id == connector_id,
            connectors_t.c.revoked == 0,
            or_(
                runtime_types_t.c.present == 1,
                device_runtimes_t.c.config_json.is_not(None),
                device_runtimes_t.c.runtime_id != device_runtimes_t.c.runtime_type,
            ),
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
        return [_runtime_row(row) for row in rows]

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
            runtime_types_t.c.present.label("type_present"),
            runtime_types_t.c.available.label("type_available"),
            runtime_types_t.c.reason.label("type_reason"),
            runtime_types_t.c.discovery_json.label("type_discovery_json"),
            runtime_types_t.c.metadata_json.label("type_metadata_json"),
            runtime_types_t.c.config_schema_json.label("type_config_schema_json"),
            runtime_types_t.c.ui_schema_json.label("type_ui_schema_json"),
            runtime_types_t.c.defaults_json.label("type_defaults_json"),
            runtime_types_t.c.capabilities_json.label("type_capabilities_json"),
            runtime_types_t.c.last_discovered_at.label("type_last_discovered_at"),
        )
        .join(
            runtime_types_t,
            (runtime_types_t.c.connector_id == device_runtimes_t.c.connector_id)
            & (runtime_types_t.c.runtime_type == device_runtimes_t.c.runtime_type),
        )
        .join(connectors_t, connectors_t.c.id == device_runtimes_t.c.connector_id)
    )


def _runtime_type_row(row: Any) -> dict[str, Any]:
    discovery = _json_loads(row["discovery_json"]) or {}
    descriptor = _stored_v2_descriptor(discovery)
    public_discovery = {} if descriptor is not None else discovery
    config_schema = descriptor.get("configSchema") if descriptor is not None else None
    return {
        "connectorId": str(row["connector_id"]),
        "runtimeType": str(row["runtime_type"]),
        "implementationType": (
            descriptor.get("implementationType")
            if descriptor is not None
            else str(row["implementation_type"])
        ),
        "displayName": str(row["display_name"]),
        "description": row["description"],
        "present": bool(row["present"]),
        "available": bool(row["available"]),
        "reason": row["reason"],
        "recommended": bool(row["recommended"]),
        "recommendationRank": row["recommendation_rank"],
        "discovery": public_discovery,
        "configSchema": config_schema,
        "schema": _json_loads(row["config_schema_json"]),
        "uiSchema": _json_loads(row["ui_schema_json"]) or {},
        "defaults": _json_loads(row["defaults_json"]) or {},
        "capabilities": _json_loads(row["capabilities_json"]) or {},
        "metadata": _json_loads(row["metadata_json"]) or {},
        "instancePolicy": str(row["instance_policy"]),
        "maxInstances": row["max_instances"],
        "lastDiscoveredAt": str(row["last_discovered_at"]),
        "createdAt": str(row["created_at"]),
        "updatedAt": str(row["updated_at"]),
    }


def _runtime_row(row: Any) -> dict[str, Any]:
    name = str(row["name"])
    discovery = _json_loads(row["type_discovery_json"]) or {}
    return {
        "connectorId": str(row["connector_id"]),
        "runtimeId": str(row["runtime_id"]),
        "runtimeType": str(row["runtime_type"]),
        "name": name,
        "displayName": name,
        "typeDisplayName": str(row["type_display_name"]),
        "present": bool(row["type_present"]),
        "available": bool(row["type_available"]),
        "reason": row["type_reason"],
        "configured": row["config_json"] is not None,
        "active": bool(row["active"]),
        "status": str(row["status"]),
        "discovery": {} if _stored_v2_descriptor(discovery) is not None else discovery,
        "metadata": _json_loads(row["type_metadata_json"]) or {},
        "schema": _json_loads(row["type_config_schema_json"]),
        "uiSchema": _json_loads(row["type_ui_schema_json"]) or {},
        "defaults": _json_loads(row["type_defaults_json"]) or {},
        "capabilities": _json_loads(row["type_capabilities_json"]) or {},
        "config": _json_loads(row["config_json"]),
        "error": _json_loads(row["error_json"]),
        "lastDiscoveredAt": str(row["type_last_discovered_at"]),
        "createdAt": str(row["created_at"]),
        "updatedAt": str(row["updated_at"]),
    }


def _stored_v2_descriptor(discovery: dict[str, Any]) -> dict[str, Any] | None:
    descriptor = discovery.get(_CONTROL_V2_DESCRIPTOR_KEY)
    return descriptor if isinstance(descriptor, dict) else None


def _unique_runtime_name(
    display_name: str,
    *,
    runtime_id: str,
    used_name_keys: set[str],
) -> str:
    try:
        base = normalize_runtime_instance_name(display_name)
    except RuntimeIdentityError:
        base = normalize_runtime_instance_name(runtime_id)
    candidate = base
    key = runtime_instance_name_key(candidate)
    suffix = 1
    while key in used_name_keys:
        marker = runtime_id if suffix == 1 else f"{runtime_id}-{suffix}"
        candidate = normalize_runtime_instance_name(f"{base} ({marker})")
        key = runtime_instance_name_key(candidate)
        suffix += 1
    used_name_keys.add(key)
    return candidate


def _public_runtime_metadata(value: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "protocolVersion",
        "profile",
        "storageMode",
        "sameSessionWriterLimit",
        "crossProcessWriterExclusion",
        "dshVersion",
        "bridgeVersion",
    }
    return {key: item for key, item in value.items() if key in allowed}
