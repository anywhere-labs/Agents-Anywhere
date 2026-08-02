from __future__ import annotations

import json
import asyncio
import threading
from copy import deepcopy
from typing import Any

from sqlalchemy import create_engine, insert, select, update
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import create_async_engine

from agent_server.infra.db import instance_settings as instance_settings_t
from agent_server.infra.repositories import InstanceSettingsRepository, RuntimeSettingsRepository
from agent_server.core.runtime_config import (
    DEFAULT_RUNTIME_CONFIG_SCHEMAS,
    ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS,
    PersistedRuntimeConfigError,
    RuntimeConfigSchema,
    apply_settings_patch,
    default_runtime_settings,
    filter_runtime_settings,
    inherited_runtime_setting_keys,
    merge_settings,
    normalize_runtime_settings,
    normalize_setting_constraints,
    rollback_safe_inherited_runtime_settings,
    runtime_schema_key,
    schema_with_user_agent_defaults,
    is_current_builtin_codex_schema,
    is_rollback_safe_codex_schema,
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
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise PersistedRuntimeConfigError("invalid persisted runtime config JSON") from exc


def _persistent_schema_json(schema: RuntimeConfigSchema) -> str:
    """Serialize a rollback-safe schema without new-only option metadata."""
    raw = schema.model_dump(exclude_none=True)

    def strip_option_metadata(value: Any) -> Any:
        if isinstance(value, list):
            return [strip_option_metadata(item) for item in value]
        if isinstance(value, dict):
            return {
                key: strip_option_metadata(item)
                for key, item in value.items()
                if key != "isDefault"
            }
        return value

    return _json_dumps(strip_option_metadata(raw))


def _runtime_schema_insert_if_missing(
    conn: Any,
    *,
    key: str,
    value: str,
    updated_at: str,
) -> Any:
    values = {"key": key, "value": value, "updated_at": updated_at}
    if conn.dialect.name == "sqlite":
        return sqlite_insert(instance_settings_t).values(**values).on_conflict_do_nothing(
            index_elements=["key"]
        )
    if conn.dialect.name == "postgresql":
        return postgresql_insert(instance_settings_t).values(**values).on_conflict_do_nothing(
            index_elements=["key"]
        )
    return insert(instance_settings_t).values(**values)


def _inherited_keys_after_patch(
    runtime: str,
    persisted: Any,
    patch: dict[str, Any] | None,
) -> set[str]:
    keys = inherited_runtime_setting_keys(runtime, persisted)
    if runtime != "codex" or not patch:
        return keys
    for key in {"model", "effort"} & set(patch):
        if patch[key] is None:
            keys.add(key)
        else:
            keys.discard(key)
    return keys


def _should_reseed_runtime_schema(
    runtime: str,
    existing: str | None,
    persisted_schema: RuntimeConfigSchema,
) -> bool:
    if existing is None:
        return True
    try:
        stored = validate_runtime_schema(runtime, _json_loads(existing))
    except Exception:
        # Invalid instance-owned schema remains observable through the read
        # endpoint; do not silently replace operator data.
        return False
    if runtime == "codex":
        # Only exact built-ins are safe to converge. Any differing v3/v4
        # schema may be operator customisation and is deliberately preserved.
        if is_current_builtin_codex_schema(stored):
            return True
        if is_rollback_safe_codex_schema(stored):
            return False
        if (
            not stored.fields
            and stored.schemaVersion
            in {persisted_schema.schemaVersion, DEFAULT_RUNTIME_CONFIG_SCHEMAS["codex"].schemaVersion}
        ):
            return True
        return _is_empty_builtin_schema(stored, persisted_schema)
    if stored.schemaVersion < persisted_schema.schemaVersion:
        return True
    return _is_empty_builtin_schema(stored, persisted_schema)


def _is_empty_builtin_schema(
    stored: RuntimeConfigSchema,
    expected: RuntimeConfigSchema,
) -> bool:
    # An empty same-version built-in schema is a known interrupted-seed shape.
    # Do not attempt to infer intent from a non-empty schema: that could erase
    # a valid operator customisation.
    return (
        stored.runtime == expected.runtime
        and stored.schemaVersion == expected.schemaVersion
        and not stored.fields
        and bool(expected.fields)
    )


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
            persisted = ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS.get(runtime, schema)
            if _should_reseed_runtime_schema(runtime, existing, persisted):
                await self._instance_settings.set(
                    key,
                    _persistent_schema_json(persisted),
                )

    async def get_runtime_config_schema(self, runtime: str) -> RuntimeConfigSchema:
        value = await self._instance_settings.get(runtime_schema_key(runtime))
        if value is None:
            # ACP / unknown agents: empty schema (no configurable fields yet).
            if runtime not in DEFAULT_RUNTIME_CONFIG_SCHEMAS:
                return RuntimeConfigSchema(runtime=runtime, schemaVersion=1, fields=[])
            raise KeyError(runtime)
        try:
            raw = _json_loads(value)
            schema = validate_runtime_schema(runtime, raw)
            if runtime == "codex" and is_rollback_safe_codex_schema(schema):
                # GPT-5.6 is an in-memory projection over the durable v3
                # baseline.  Do not write here: a rolled-back server must see
                # exactly the durable data it expects.
                return deepcopy(DEFAULT_RUNTIME_CONFIG_SCHEMAS["codex"])
            return schema
        except Exception as exc:
            raise PersistedRuntimeConfigError(
                f"invalid persisted runtime config schema for {runtime}"
            ) from exc

    async def get_runtime_config_schema_for_user(
        self,
        runtime: str,
        *,
        user_id: str | None,
    ) -> RuntimeConfigSchema:
        schema = await self.get_runtime_config_schema(runtime)
        defaults = await self._get_user_agent_defaults(user_id)
        return schema_with_user_agent_defaults(schema, defaults.get(runtime))

    async def get_device_runtime_config_schema(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
    ) -> RuntimeConfigSchema:
        """Seed schema + user defaults + live ACP modelOptions from device report."""
        schema = await self.get_runtime_config_schema_for_user(runtime, user_id=user_id)
        return await self._merge_schema_with_device_options(
            schema,
            connector_id=connector_id,
            runtime=runtime,
        )

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
        schema = await self.get_device_runtime_config_schema(
            connector_id, runtime, user_id=user_id
        )
        value = _json_loads(
            await self._runtime_settings.get_device_settings_json(connector_id, runtime)
        )
        settings = filter_runtime_settings(
            normalize_runtime_settings(runtime, value if isinstance(value, dict) else {}),
            schema,
            session_override=False,
        )
        effective = merge_settings(default_runtime_settings(runtime), settings)
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
        schema = await self.get_device_runtime_config_schema(
            connector_id,
            runtime,
            user_id=user_id or connector_user_id,
        )
        normalized_patch = validate_runtime_settings(
            runtime,
            patch,
            schema,
            session_override=False,
        )
        raw_current = _json_loads(
            await self._runtime_settings.get_device_settings_json(connector_id, runtime)
        )
        current_stored = filter_runtime_settings(
            normalize_runtime_settings(
                runtime,
                raw_current if isinstance(raw_current, dict) else {},
            ),
            schema,
            session_override=False,
        )
        current = normalize_setting_constraints(
            runtime,
            merge_settings(default_runtime_settings(runtime), current_stored),
            explicit_keys=set(),
            schema=schema,
        )
        next_settings = apply_settings_patch(
            current,
            normalized_patch,
            prune_nulls=False,
            runtime=runtime,
            explicit_keys=set(normalized_patch),
            schema=schema,
        )
        inherited_keys = _inherited_keys_after_patch(runtime, raw_current, normalized_patch)
        persisted_settings = rollback_safe_inherited_runtime_settings(
            runtime,
            next_settings,
            inherited_keys=inherited_keys,
        )
        # Rows containing only inherited Codex model/effort must keep the
        # preceding server's schema version too.  A deliberate model/effort
        # choice keeps the current version and is never rewritten here.
        schema_version = schema.schemaVersion
        if runtime == "codex" and inherited_keys == {"model", "effort"}:
            schema_version = ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS["codex"].schemaVersion
        await self._runtime_settings.upsert_device_settings_json(
            connector_id,
            runtime,
            settings_json=_json_dumps(persisted_settings),
            schema_version=schema_version,
            updated_at=utc_now(),
        )
        return next_settings

    async def get_session_runtime_settings_override(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        row = await self._runtime_settings.get_session_runtime_row(session_id, user_id=user_id)
        runtime = str(row["runtime"])
        schema = await self._get_session_runtime_config_schema(
            row,
            user_id=user_id,
        )
        value = _json_loads(row["runtime_settings_override"])
        override = filter_runtime_settings(
            normalize_runtime_settings(
                runtime,
                value if isinstance(value, dict) else {},
            ),
            schema,
            session_override=True,
        )
        if runtime != "codex":
            return override
        effective = merge_settings(default_runtime_settings(runtime), override)
        return normalize_setting_constraints(
            runtime,
            effective,
            explicit_keys=set(),
            schema=schema,
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
        schema = await self._get_session_runtime_config_schema(row, user_id=user_id)
        normalized_patch = validate_runtime_settings(
            runtime,
            patch,
            schema,
            session_override=True,
        )
        current = _json_loads(row["runtime_settings_override"])
        current_settings = filter_runtime_settings(
            normalize_runtime_settings(
                runtime,
                current if isinstance(current, dict) else {},
            ),
            schema,
            session_override=True,
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
        if runtime != "codex":
            return next_override
        # The durable override may omit inherited Codex values.  Preserve the
        # response contract by returning the effective projection clients saw
        # before this storage compatibility layer existed.
        return next_effective

    async def get_effective_runtime_settings(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        row = await self._runtime_settings.get_session_runtime_row(session_id, user_id=user_id)
        return await self._effective_runtime_settings_from_row(row, user_id=user_id)

    async def get_effective_runtime_settings_for_message(
        self,
        session_id: str,
        patch: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Validate ephemeral composer overrides against the device's live schema.

        The result is intentionally not persisted as a session override.  This
        keeps the composer contract identical to the settings API while
        guaranteeing an invalid message cannot change session state or reach a
        connector RPC.
        """
        row = await self._runtime_settings.get_session_runtime_row(session_id, user_id=user_id)
        return await self._effective_runtime_settings_from_row(
            row,
            user_id=user_id,
            patch=patch,
        )

    async def _effective_runtime_settings_from_row(
        self,
        row: Any,
        *,
        user_id: str | None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        runtime = str(row["runtime"])
        schema = await self._get_session_runtime_config_schema(row, user_id=user_id)
        override = _json_loads(row["runtime_settings_override"])
        override_settings = filter_runtime_settings(
            normalize_runtime_settings(
                runtime,
                override if isinstance(override, dict) else {},
            ),
            schema,
            session_override=True,
        )
        effective = merge_settings(default_runtime_settings(runtime), override_settings)
        effective = normalize_setting_constraints(
            runtime,
            effective,
            explicit_keys=set(),
            schema=schema,
        )
        if patch:
            normalized_patch = validate_runtime_settings(
                runtime,
                patch,
                schema,
                session_override=True,
            )
            effective = apply_settings_patch(
                effective,
                normalized_patch,
                runtime=runtime,
                explicit_keys=set(normalized_patch),
                schema=schema,
            )
        return effective

    async def get_initial_runtime_settings_for_connector_agent(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        bundle = await self.get_initial_runtime_settings_bundle(
            connector_id,
            runtime,
            user_id=user_id,
            patch=patch,
        )
        return bundle["effective"]

    async def get_initial_runtime_settings_bundle(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        cwd: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Resolve effective, durable, and connector views from one snapshot."""
        await self._runtime_settings.require_connector(connector_id, user_id=user_id)
        schema = await self.get_device_runtime_config_schema(
            connector_id,
            runtime,
            user_id=user_id,
        )
        raw_device_settings = _json_loads(
            await self._runtime_settings.get_device_settings_json(connector_id, runtime)
        )
        stored_settings = filter_runtime_settings(
            normalize_runtime_settings(
                runtime,
                raw_device_settings if isinstance(raw_device_settings, dict) else {},
            ),
            schema,
            session_override=False,
        )
        effective = normalize_setting_constraints(
            runtime,
            merge_settings(default_runtime_settings(runtime), stored_settings),
            explicit_keys=set(),
            schema=schema,
        )
        if patch is not None:
            normalized_patch = validate_runtime_settings(
                runtime,
                patch,
                schema,
                session_override=False,
            )
            effective = apply_settings_patch(
                effective,
                normalized_patch,
                runtime=runtime,
                explicit_keys=set(normalized_patch),
                schema=schema,
            )
        inherited_keys = _inherited_keys_after_patch(runtime, raw_device_settings, patch)
        durable = rollback_safe_inherited_runtime_settings(
            runtime,
            effective,
            inherited_keys=inherited_keys,
        )
        connector = serializer_for_runtime(runtime).serialize(settings=effective, cwd=cwd)
        return {"effective": effective, "durable": durable, "connector": connector}

    async def get_durable_initial_runtime_settings_for_connector_agent(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return the session snapshot safe to write across a rollback.

        The public/effective settings still project this server's default.
        Only a model/effort inherited from the raw device row is collapsed to
        ``null`` for durable session state; an explicit device or request
        choice remains untouched.
        """
        bundle = await self.get_initial_runtime_settings_bundle(
            connector_id,
            runtime,
            user_id=user_id,
            patch=patch,
        )
        return bundle["durable"]

    async def serialize_initial_settings_for_connector_agent(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        cwd: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        bundle = await self.get_initial_runtime_settings_bundle(
            connector_id,
            runtime,
            user_id=user_id,
            cwd=cwd,
            patch=patch,
        )
        return bundle["connector"]

    async def _get_user_agent_defaults(self, user_id: str | None) -> dict[str, Any]:
        if user_id is None or self._user_defaults_provider is None:
            return {}
        return await self._user_defaults_provider.get_user_agent_defaults(user_id)

    async def _get_session_runtime_config_schema(
        self,
        row: Any,
        *,
        user_id: str | None,
    ) -> RuntimeConfigSchema:
        runtime = str(row["runtime"])
        schema = await self.get_runtime_config_schema_for_user(
            runtime,
            user_id=user_id or str(row["connector_user_id"]),
        )
        return await self._merge_schema_with_device_options(
            schema,
            connector_id=str(row.get("connector_id") or ""),
            runtime=runtime,
        )

    async def _merge_schema_with_device_options(
        self,
        schema: RuntimeConfigSchema,
        *,
        connector_id: str,
        runtime: str,
    ) -> RuntimeConfigSchema:
        if not connector_id or self._user_defaults_provider is None:
            return schema
        getter = getattr(self._user_defaults_provider, "get_runtime_report", None)
        if not callable(getter):
            return schema
        try:
            report = await getter(connector_id, runtime)
        except Exception:
            return schema
        if not isinstance(report, dict):
            return schema
        from agent_server.core.runtime_config import merge_schema_with_agent_options

        return merge_schema_with_agent_options(
            schema,
            model_options=report.get("modelOptions") if isinstance(report.get("modelOptions"), list) else None,
            mode_options=report.get("modeOptions") if isinstance(report.get("modeOptions"), list) else None,
            config_options=report.get("configOptions") if isinstance(report.get("configOptions"), list) else None,
        )


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
        persisted = ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS.get(runtime, schema)
        key = runtime_schema_key(runtime)
        persisted_json = _persistent_schema_json(persisted)
        conn.execute(
            _runtime_schema_insert_if_missing(
                conn,
                key=key,
                value=persisted_json,
                updated_at=now,
            )
        )
        existing = conn.execute(
            select(instance_settings_t.c.value).where(instance_settings_t.c.key == key)
        ).first()
        existing_value = existing.value if existing is not None else None
        if _should_reseed_runtime_schema(runtime, existing_value, persisted):
            values = {
                "value": persisted_json,
                "updated_at": now,
            }
            conn.execute(
                update(instance_settings_t)
                .where(instance_settings_t.c.key == key)
                .values(**values)
            )


def _seed_runtime_config_schemas_async_in_thread(async_url: str) -> None:
    captured: list[BaseException] = []

    async def _run() -> None:
        engine = create_async_engine(async_url, future=True)
        try:
            async with engine.begin() as conn:
                now = utc_now()
                for runtime, schema in DEFAULT_RUNTIME_CONFIG_SCHEMAS.items():
                    persisted = ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS.get(runtime, schema)
                    key = runtime_schema_key(runtime)
                    persisted_json = _persistent_schema_json(persisted)
                    await conn.execute(
                        _runtime_schema_insert_if_missing(
                            conn,
                            key=key,
                            value=persisted_json,
                            updated_at=now,
                        )
                    )
                    existing = (
                        await conn.execute(
                            select(instance_settings_t.c.value).where(
                                instance_settings_t.c.key == key
                            )
                        )
                    ).first()
                    existing_value = existing.value if existing is not None else None
                    if _should_reseed_runtime_schema(runtime, existing_value, persisted):
                        values = {
                            "value": persisted_json,
                            "updated_at": now,
                        }
                        await conn.execute(
                            update(instance_settings_t)
                            .where(instance_settings_t.c.key == key)
                            .values(**values)
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
