from __future__ import annotations

import json

from agent_server.infra.repositories.store_support import *
from agent_server.core.runtime_config import (
    DEFAULT_RUNTIME_CONFIG_SCHEMAS,
    ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS,
    PersistedRuntimeConfigError,
    claude_efforts_for_model,
    codex_efforts_for_model,
    inherited_runtime_setting_keys,
    merge_settings,
    rollback_safe_inherited_runtime_settings,
)


class AgentCatalogRepositoryMixin:
    async def seed_agent_catalog(self) -> None:
        """Insert any catalog rows declared in SEED_AGENT_CATALOG that are
        missing. Existing labels and descriptions remain operator-editable;
        Codex defaults and seed ordering are migrated idempotently on startup.
        """
        await self._seed_table(agent_modes_t, SEED_AGENT_MODES)
        await self._seed_table(agent_models_t, SEED_AGENT_MODELS)
        await self._seed_table(agent_efforts_t, SEED_AGENT_EFFORTS)
        async with self._engine.begin() as conn:
            await _migrate_codex_catalog_async(conn)

    async def _seed_table(self, table: Any, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        async with self._engine.begin() as conn:
            await conn.execute(_seed_insert_statement(conn, table, rows))

    # --- runtime config schema / settings ------------------------------------


    async def list_agent_modes(self, runtime: str) -> list[AgentCatalogEntry]:
        return await self._list_agent_catalog(agent_modes_t, runtime)


    async def list_agent_models(self, runtime: str) -> list[AgentCatalogEntry]:
        return await self._list_agent_catalog(agent_models_t, runtime)


    async def list_agent_efforts(self, runtime: str) -> list[AgentCatalogEntry]:
        return await self._list_agent_catalog(agent_efforts_t, runtime)


    async def _list_agent_catalog(self, table: Any, runtime: str) -> list[AgentCatalogEntry]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(table)
                    .where(table.c.runtime == runtime)
                    .order_by(table.c.sort_order.asc(), table.c.key.asc())
                )
            ).mappings().all()
        return [
            AgentCatalogEntry(
                runtime=row["runtime"],
                key=row["key"],
                displayLabel=row["display_label"],
                description=row["description"],
                isDefault=bool(row["is_default"]),
                sortOrder=int(row["sort_order"]),
            )
            for row in rows
        ]

    # --- connector preferences ------------------------------------------------


    async def get_user_agent_defaults(self, user_id: str) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            return await self._get_user_agent_defaults_on_conn(conn, user_id)


    async def _get_user_agent_defaults_on_conn(
        self,
        conn: Any,
        user_id: str,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for runtime in SUPPORTED_DEFAULT_AGENT_RUNTIMES:
            result[runtime] = await self._get_user_agent_default_runtime_on_conn(
                conn,
                user_id,
                runtime,
            )
        return result


    async def update_user_agent_defaults(
        self,
        user_id: str,
        patch: dict[str, Any],
    ) -> dict[str, Any]:
        now = utc_now()
        async with self._engine.begin() as conn:
            user_exists = (
                await conn.execute(select(users_t.c.id).where(users_t.c.id == user_id))
            ).first()
            if user_exists is None:
                raise KeyError(user_id)
            for runtime, raw_update in patch.items():
                if runtime not in SUPPORTED_DEFAULT_AGENT_RUNTIMES:
                    raise ValueError(f"unsupported runtime: {runtime}")
                if not isinstance(raw_update, dict):
                    raise ValueError(f"{runtime} must be an object")
                # An empty runtime object is intentionally a no-op.  In
                # particular, do not materialize the current global catalog
                # into models_json merely because a client PATCHed `{}`.
                if "models" not in raw_update:
                    continue
                current = await self._get_user_agent_default_runtime_on_conn(
                    conn,
                    user_id,
                    runtime,
                )
                enabled = bool(current["enabled"])
                settings = current["settings"]
                models = _normalize_model_catalog_entries(runtime, raw_update["models"])
                await self._upsert_user_agent_default_on_conn(
                    conn,
                    user_id=user_id,
                    runtime=runtime,
                    enabled=enabled,
                    settings=settings,
                    models=models,
                    inherited_settings_keys=current["_inheritedSettingsKeys"],
                    updated_at=now,
                )
        return await self.get_user_agent_defaults(user_id)


    async def apply_user_agent_defaults_to_connector(
        self,
        *,
        user_id: str,
        connector_id: str,
    ) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            for runtime in SUPPORTED_DEFAULT_AGENT_RUNTIMES:
                item = await self._get_user_agent_default_runtime_on_conn(conn, user_id, runtime)
                settings = item["settings"]
                schema = DEFAULT_RUNTIME_CONFIG_SCHEMAS.get(runtime)
                if schema is None:
                    continue
                durable_settings = rollback_safe_inherited_runtime_settings(
                    runtime,
                    settings,
                    inherited_keys=item["_inheritedSettingsKeys"],
                )
                schema_version = schema.schemaVersion
                if runtime == "codex" and item["_inheritedSettingsKeys"] == {"model", "effort"}:
                    schema_version = ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS["codex"].schemaVersion
                await conn.execute(
                    insert(device_agent_settings_t).values(
                        connector_id=connector_id,
                        runtime=runtime,
                        settings_json=_json_dumps(durable_settings),
                        schema_version=schema_version,
                        updated_at=now,
                    )
                )


    async def _get_user_agent_default_runtime(
        self,
        user_id: str,
        runtime: str,
    ) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            return await self._get_user_agent_default_runtime_on_conn(conn, user_id, runtime)


    async def _get_user_agent_default_runtime_on_conn(
        self,
        conn: Any,
        user_id: str,
        runtime: str,
    ) -> dict[str, Any]:
        row = (
            await conn.execute(
                select(user_agent_defaults_t).where(
                    user_agent_defaults_t.c.user_id == user_id,
                    user_agent_defaults_t.c.runtime == runtime,
                )
            )
        ).mappings().first()
        if row is not None:
            enabled = bool(row["enabled"])
            stored_settings = _json_loads(row["settings_json"]) or {}
            settings = _project_user_default_settings(runtime, stored_settings)
            # Read exact legacy built-in snapshots through the current global
            # catalog without rewriting them, so a server rollback stays safe.
            models = (
                []
                if runtime == "codex"
                and _is_legacy_builtin_codex_models_json(row["models_json"])
                else _catalog_entries_from_json(runtime, row["models_json"])
            )
        else:
            enabled = True
            stored_settings = {}
            settings = _project_user_default_settings(runtime, stored_settings)
            models = []
        if not models:
            models = await self._list_agent_catalog_on_conn(conn, agent_models_t, runtime)
            efforts = await self._list_agent_catalog_on_conn(conn, agent_efforts_t, runtime)
            if not models:
                models = _default_catalog_from_runtime_schema(runtime, "model")
            if not efforts:
                efforts = _default_catalog_from_runtime_schema(runtime, "effort")
            if runtime == "codex" and _is_rollback_safe_codex_catalog(models, efforts):
                # Catalog persistence remains readable by the preceding
                # server; GPT-5.6 is projected only while the new server is
                # serving this exact built-in baseline.
                models = _default_catalog_from_runtime_schema(runtime, "model")
                efforts = _default_catalog_from_runtime_schema(runtime, "effort")
            models = _models_with_default_efforts(runtime, models, efforts)
        return {
            "runtime": runtime,
            "enabled": enabled,
            "settings": settings,
            "models": models,
            # Private provenance used only while applying/updating defaults.
            # API response builders copy the public fields explicitly.
            "_inheritedSettingsKeys": inherited_runtime_setting_keys(runtime, stored_settings),
        }


    async def _list_agent_catalog_on_conn(
        self,
        conn: Any,
        table: Any,
        runtime: str,
    ) -> list[AgentCatalogEntry]:
        rows = (
            await conn.execute(
                select(table)
                .where(table.c.runtime == runtime)
                .order_by(table.c.sort_order.asc(), table.c.key.asc())
            )
        ).mappings().all()
        return [
            AgentCatalogEntry(
                runtime=row["runtime"],
                key=row["key"],
                displayLabel=row["display_label"],
                description=row["description"],
                isDefault=bool(row["is_default"]),
                sortOrder=int(row["sort_order"]),
            )
            for row in rows
        ]


    async def _upsert_user_agent_default_on_conn(
        self,
        conn: Any,
        *,
        user_id: str,
        runtime: str,
        enabled: bool,
        settings: dict[str, Any],
        models: list[AgentCatalogEntry],
        inherited_settings_keys: set[str],
        updated_at: str,
    ) -> None:
        durable_settings = rollback_safe_inherited_runtime_settings(
            runtime,
            settings,
            inherited_keys=inherited_settings_keys,
        )
        values = {
            "user_id": user_id,
            "runtime": runtime,
            "enabled": 1 if enabled else 0,
            "settings_json": _json_dumps(durable_settings),
            "models_json": _json_dumps([entry.model_dump() for entry in models]),
            "updated_at": updated_at,
        }
        existing = (
            await conn.execute(
                select(user_agent_defaults_t.c.user_id).where(
                    user_agent_defaults_t.c.user_id == user_id,
                    user_agent_defaults_t.c.runtime == runtime,
                )
            )
        ).first()
        if existing is None:
            await conn.execute(insert(user_agent_defaults_t).values(**values))
        else:
            await conn.execute(
                update(user_agent_defaults_t)
                .where(
                    user_agent_defaults_t.c.user_id == user_id,
                    user_agent_defaults_t.c.runtime == runtime,
                )
                .values(**values)
            )


def _project_user_default_settings(runtime: str, stored: Any) -> dict[str, Any]:
    """Project nullable durable defaults through this server's defaults."""
    persisted = stored if isinstance(stored, dict) else {}
    return merge_settings(default_agent_settings(runtime), persisted)


def _catalog_entries_from_json(runtime: str, raw: str | None) -> list[AgentCatalogEntry]:
    if raw is None:
        return []
    try:
        data = _json_loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PersistedRuntimeConfigError(f"invalid persisted {runtime} models_json") from exc
    if not isinstance(data, list):
        raise PersistedRuntimeConfigError(
            f"invalid persisted {runtime} models_json: expected a list"
        )
    return _normalize_model_catalog_entries(runtime, data)


def _normalize_model_catalog_entries(runtime: str, raw: Any) -> list[AgentCatalogEntry]:
    fallback_efforts = _default_catalog_from_runtime_schema(runtime, "effort")
    normalized = _normalize_user_catalog_entries(
        runtime,
        raw,
        default_efforts_by_model={
            entry.get("key") if isinstance(entry, dict) else getattr(entry, "key", ""):
                _default_efforts_for_model(runtime, entry.get("key") if isinstance(entry, dict) else getattr(entry, "key", ""), fallback_efforts)
            for entry in raw
        } if isinstance(raw, list) else {},
    )
    return normalized


def _normalize_user_catalog_entries(
    runtime: str,
    raw: Any,
    *,
    default_efforts_by_model: dict[str, list[AgentCatalogEntry]] | None = None,
) -> list[AgentCatalogEntry]:
    if not isinstance(raw, list):
        raise ValueError("catalog entries must be a list")
    result: list[AgentCatalogEntry] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError("catalog entry must be an object")
        key = str(item.get("key") or "").strip()
        label = str(item.get("displayLabel") or "").strip()
        if not key:
            raise ValueError("catalog entry key is required")
        if not label:
            raise ValueError("catalog entry displayLabel is required")
        if key in seen:
            raise ValueError(f"duplicate catalog entry: {key}")
        seen.add(key)
        result.append(
            AgentCatalogEntry(
                runtime=runtime,
                key=key,
                displayLabel=label,
                description=item.get("description") if isinstance(item.get("description"), str) else None,
                isDefault=index == 0,
                sortOrder=int(item.get("sortOrder") if item.get("sortOrder") is not None else index + 1),
                efforts=_normalize_effort_entries(
                    runtime,
                    item.get("efforts"),
                    default_efforts=(default_efforts_by_model or {}).get(key, []),
                ),
            )
        )
    return result


def _normalize_effort_entries(
    runtime: str,
    raw: Any,
    *,
    default_efforts: list[AgentCatalogEntry],
) -> list[AgentCatalogEntry]:
    if raw is None:
        return default_efforts
    return [
        entry.model_copy(update={"efforts": []})
        for entry in _normalize_user_catalog_entries(runtime, raw, default_efforts_by_model={})
    ]


def _default_catalog_from_runtime_schema(runtime: str, field_key: str) -> list[AgentCatalogEntry]:
    schema = DEFAULT_RUNTIME_CONFIG_SCHEMAS.get(runtime)
    if schema is None:
        return []
    for field in schema.fields:
        if field.key != field_key:
            continue
        options = field.options or []
        has_default = any(option.isDefault for option in options)
        return [
            AgentCatalogEntry(
                runtime=runtime,
                key=str(option.value),
                displayLabel=option.label,
                description=option.description,
                isDefault=option.isDefault if has_default else index == 0,
                sortOrder=index + 1,
                efforts=[],
            )
            for index, option in enumerate(options)
            if isinstance(option.value, str)
        ]
    return []


def _models_with_default_efforts(
    runtime: str,
    models: list[AgentCatalogEntry],
    efforts: list[AgentCatalogEntry],
) -> list[AgentCatalogEntry]:
    return [
        model.model_copy(
            update={"efforts": _default_efforts_for_model(runtime, model.key, efforts)}
        )
        for model in models
    ]


def _is_rollback_safe_codex_catalog(
    models: list[AgentCatalogEntry],
    efforts: list[AgentCatalogEntry],
) -> bool:
    return (
        _catalog_entry_rows_signature(models) == _seed_rows_signature(SEED_AGENT_MODELS, "codex")
        and _catalog_entry_rows_signature(efforts) == _seed_rows_signature(SEED_AGENT_EFFORTS, "codex")
    )


def _catalog_entry_rows_signature(entries: list[AgentCatalogEntry]) -> tuple[tuple[str, str, str, int, bool], ...]:
    return tuple(
        (
            entry.key,
            entry.displayLabel,
            entry.description or "",
            entry.sortOrder,
            entry.isDefault,
        )
        for entry in entries
    )


def _seed_rows_signature(
    rows: list[dict[str, Any]], runtime: str
) -> tuple[tuple[str, str, str, int, bool], ...]:
    return tuple(
        (
            str(row["key"]),
            str(row["display_label"]),
            str(row.get("description") or ""),
            int(row["sort_order"]),
            bool(row["is_default"]),
        )
        for row in rows
        if row["runtime"] == runtime
    )


def _default_efforts_for_model(
    runtime: str,
    model: str,
    efforts: list[AgentCatalogEntry],
) -> list[AgentCatalogEntry]:
    if runtime == "claude":
        allowed = claude_efforts_for_model(model)
    elif runtime == "codex":
        allowed = codex_efforts_for_model(model)
    else:
        return [entry.model_copy(update={"efforts": []}) for entry in efforts]
    return [
        entry.model_copy(update={"efforts": []})
        for entry in efforts
        if entry.key in allowed
    ]
