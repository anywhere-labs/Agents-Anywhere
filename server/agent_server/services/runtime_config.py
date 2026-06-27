from __future__ import annotations

import json
import asyncio
import threading
from typing import Any

from sqlalchemy import create_engine, insert, select, update
from sqlalchemy.ext.asyncio import create_async_engine

from agent_server.infra.db import instance_settings as instance_settings_t
from agent_server.infra.repositories import InstanceSettingsRepository, RuntimeSettingsRepository
from agent_server.core.runtime_config import (
    DEFAULT_RUNTIME_CONFIG_SCHEMAS,
    RuntimeConfigSchema,
    apply_settings_patch,
    default_runtime_settings,
    merge_settings,
    normalize_runtime_settings,
    normalize_setting_constraints,
    runtime_schema_key,
    schema_with_user_agent_defaults,
    validate_runtime_schema,
    validate_runtime_settings,
)
from agent_server.core.utc import utc_now
from agent_server.infra.runtimes.serializers import serializer_for_runtime


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_loads(value: str | None) -> Any:
    if not value:
        return None
    return json.loads(value)


class RuntimeConfigService:
    def __init__(
        self,
        instance_settings: InstanceSettingsRepository,
        runtime_settings: RuntimeSettingsRepository,
        user_defaults_provider: Any | None = None,
    ) -> None:
        self._instance_settings = instance_settings
        self._runtime_settings = runtime_settings
        self._user_defaults_provider = user_defaults_provider

    async def seed_runtime_config_schemas(self) -> None:
        for runtime, schema in DEFAULT_RUNTIME_CONFIG_SCHEMAS.items():
            key = runtime_schema_key(runtime)
            existing = await self._instance_settings.get(key)
            if existing is None:
                await self._instance_settings.set(
                    key,
                    _json_dumps(schema.model_dump(exclude_none=True)),
                )
                continue
            if _stored_schema_version(existing) < schema.schemaVersion:
                await self._instance_settings.set(
                    key,
                    _json_dumps(schema.model_dump(exclude_none=True)),
                )

    async def get_runtime_config_schema(self, runtime: str) -> RuntimeConfigSchema:
        value = await self._instance_settings.get(runtime_schema_key(runtime))
        if value is None:
            raise KeyError(runtime)
        try:
            raw = _json_loads(value)
            return validate_runtime_schema(runtime, raw)
        except Exception as exc:
            raise ValueError(f"invalid runtime config schema for {runtime}") from exc

    async def get_runtime_config_schema_for_user(
        self,
        runtime: str,
        *,
        user_id: str | None,
    ) -> RuntimeConfigSchema:
        schema = await self.get_runtime_config_schema(runtime)
        defaults = await self._get_user_agent_defaults(user_id)
        return schema_with_user_agent_defaults(schema, defaults.get(runtime))

    async def set_runtime_config_schema(
        self,
        runtime: str,
        schema_json: dict[str, Any],
    ) -> RuntimeConfigSchema:
        schema = validate_runtime_schema(runtime, schema_json)
        await self._instance_settings.set(
            runtime_schema_key(runtime),
            _json_dumps(schema.model_dump(exclude_none=True)),
        )
        return schema

    async def get_device_agent_settings(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        await self._runtime_settings.require_connector(connector_id, user_id=user_id)
        value = _json_loads(
            await self._runtime_settings.get_device_settings_json(connector_id, runtime)
        )
        settings = normalize_runtime_settings(runtime, value if isinstance(value, dict) else {})
        effective = merge_settings(default_runtime_settings(runtime), settings)
        schema = await self.get_runtime_config_schema_for_user(runtime, user_id=user_id)
        return normalize_setting_constraints(
            runtime,
            effective,
            explicit_keys=set(),
            schema=schema,
        )

    async def patch_device_agent_settings(
        self,
        connector_id: str,
        runtime: str,
        patch: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        connector_user_id = await self._runtime_settings.require_connector(connector_id, user_id=user_id)
        schema = await self.get_runtime_config_schema_for_user(
            runtime,
            user_id=user_id or connector_user_id,
        )
        normalized_patch = validate_runtime_settings(
            runtime,
            patch,
            schema,
            session_override=False,
        )
        current = await self.get_device_agent_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
        next_settings = apply_settings_patch(
            current,
            normalized_patch,
            prune_nulls=False,
            runtime=runtime,
            explicit_keys=set(normalized_patch),
            schema=schema,
        )
        await self._runtime_settings.upsert_device_settings_json(
            connector_id,
            runtime,
            settings_json=_json_dumps(next_settings),
            default_run_mode_configured=(
                runtime == "claude" and "runMode" in normalized_patch
            )
            or None,
            schema_version=schema.schemaVersion,
            updated_at=utc_now(),
        )
        return next_settings

    async def is_default_run_mode_configured(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
    ) -> bool:
        await self._runtime_settings.require_connector(connector_id, user_id=user_id)
        if runtime != "claude":
            return True
        return await self._runtime_settings.is_default_run_mode_configured(
            connector_id,
            runtime,
        )

    async def get_session_runtime_settings_override(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        row = await self._runtime_settings.get_session_runtime_row(session_id, user_id=user_id)
        value = _json_loads(row["runtime_settings_override"])
        return normalize_runtime_settings(
            str(row["runtime"]),
            value if isinstance(value, dict) else {},
        )

    async def patch_session_runtime_settings(
        self,
        session_id: str,
        patch: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        row = await self._runtime_settings.get_session_runtime_row(session_id, user_id=user_id)
        runtime = str(row["runtime"])
        schema = await self.get_runtime_config_schema_for_user(
            runtime,
            user_id=user_id or str(row["connector_user_id"]),
        )
        normalized_patch = validate_runtime_settings(
            runtime,
            patch,
            schema,
            session_override=True,
        )
        current = _json_loads(row["runtime_settings_override"])
        current_settings = normalize_runtime_settings(
            runtime,
            current if isinstance(current, dict) else {},
        )
        current_effective = merge_settings(default_runtime_settings(runtime), current_settings)
        next_effective = apply_settings_patch(
            current_effective,
            normalized_patch,
            runtime=runtime,
            explicit_keys=set(normalized_patch),
            schema=schema,
        )
        next_override = apply_settings_patch(
            current_settings,
            normalized_patch,
            prune_nulls=True,
        )
        if next_effective.get("effort") is None:
            next_override.pop("effort", None)
        await self._runtime_settings.set_session_runtime_override_json(
            session_id,
            override_json=_json_dumps(next_override) if next_override else None,
            updated_at=utc_now(),
        )
        return next_override

    async def get_effective_runtime_settings(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        row = await self._runtime_settings.get_session_runtime_row(session_id, user_id=user_id)
        runtime = str(row["runtime"])
        override = _json_loads(row["runtime_settings_override"])
        override_settings = normalize_runtime_settings(
            runtime,
            override if isinstance(override, dict) else {},
        )
        effective = merge_settings(default_runtime_settings(runtime), override_settings)
        effective = normalize_setting_constraints(
            runtime,
            effective,
            explicit_keys=set(),
            schema=await self.get_runtime_config_schema_for_user(
                runtime,
                user_id=user_id or str(row["connector_user_id"]),
            ),
        )
        if runtime == "claude":
            effective["runMode"] = effective.get("runMode") or "chat"
        return effective

    async def get_initial_runtime_settings_for_connector_agent(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        settings = await self.get_device_agent_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
        effective = merge_settings(default_runtime_settings(runtime), settings)
        if patch is None:
            return effective
        schema = await self.get_runtime_config_schema_for_user(runtime, user_id=user_id)
        normalized_patch = validate_runtime_settings(
            runtime,
            patch,
            schema,
            session_override=False,
        )
        return apply_settings_patch(
            effective,
            normalized_patch,
            runtime=runtime,
            explicit_keys=set(normalized_patch),
            schema=schema,
        )

    async def serialize_initial_settings_for_connector_agent(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        cwd: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        effective = await self.get_initial_runtime_settings_for_connector_agent(
            connector_id,
            runtime,
            user_id=user_id,
            patch=patch,
        )
        return serializer_for_runtime(runtime).serialize(settings=effective, cwd=cwd)

    async def _get_user_agent_defaults(self, user_id: str | None) -> dict[str, Any]:
        if user_id is None or self._user_defaults_provider is None:
            return {}
        return await self._user_defaults_provider.get_user_agent_defaults(user_id)


def seed_runtime_config_schemas_sync(async_url: str) -> None:
    if async_url.startswith("sqlite+aiosqlite:"):
        sync_url = "sqlite:" + async_url[len("sqlite+aiosqlite:"):]
    elif async_url.startswith("sqlite:"):
        sync_url = async_url
    else:
        _seed_runtime_config_schemas_async_in_thread(async_url)
        return

    sync_engine = create_engine(sync_url, future=True)
    try:
        with sync_engine.begin() as conn:
            _seed_runtime_config_schemas_on_sync_conn(conn)
    finally:
        sync_engine.dispose()


def _seed_runtime_config_schemas_on_sync_conn(conn: Any) -> None:
    now = utc_now()
    for runtime, schema in DEFAULT_RUNTIME_CONFIG_SCHEMAS.items():
        key = runtime_schema_key(runtime)
        existing = conn.execute(
            select(instance_settings_t.c.value).where(instance_settings_t.c.key == key)
        ).first()
        if existing is None:
            conn.execute(
                insert(instance_settings_t).values(
                    key=key,
                    value=_json_dumps(schema.model_dump(exclude_none=True)),
                    updated_at=now,
                )
            )
            continue
        if _stored_schema_version(existing.value) < schema.schemaVersion:
            conn.execute(
                update(instance_settings_t)
                .where(instance_settings_t.c.key == key)
                .values(
                    value=_json_dumps(schema.model_dump(exclude_none=True)),
                    updated_at=now,
                )
            )


def _seed_runtime_config_schemas_async_in_thread(async_url: str) -> None:
    captured: list[BaseException] = []

    async def _run() -> None:
        engine = create_async_engine(async_url, future=True)
        try:
            async with engine.begin() as conn:
                now = utc_now()
                for runtime, schema in DEFAULT_RUNTIME_CONFIG_SCHEMAS.items():
                    key = runtime_schema_key(runtime)
                    existing = (
                        await conn.execute(
                            select(instance_settings_t.c.value).where(
                                instance_settings_t.c.key == key
                            )
                        )
                    ).first()
                    if existing is None:
                        await conn.execute(
                            insert(instance_settings_t).values(
                                key=key,
                                value=_json_dumps(schema.model_dump(exclude_none=True)),
                                updated_at=now,
                            )
                        )
                        continue
                    if _stored_schema_version(existing.value) < schema.schemaVersion:
                        await conn.execute(
                            update(instance_settings_t)
                            .where(instance_settings_t.c.key == key)
                            .values(
                                value=_json_dumps(schema.model_dump(exclude_none=True)),
                                updated_at=now,
                            )
                        )
        finally:
            await engine.dispose()

    def _runner() -> None:
        try:
            asyncio.run(_run())
        except BaseException as exc:  # noqa: BLE001
            captured.append(exc)

    thread = threading.Thread(target=_runner, name="seed-runtime-config-schemas-sync")
    thread.start()
    thread.join()
    if captured:
        raise captured[0]


def _stored_schema_version(value: str | None) -> int:
    try:
        raw = _json_loads(value)
    except Exception:
        return 0
    if not isinstance(raw, dict):
        return 0
    version = raw.get("schemaVersion")
    return version if isinstance(version, int) else 0
