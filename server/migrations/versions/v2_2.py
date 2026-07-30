"""Preserve legacy settings and raw v1 data in the strict v2 model.

Revision ID: v2_2
Revises: v2_1
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "v2_2"
down_revision: str | None = "v2_1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_TABLES = (
    "agent_efforts",
    "agent_models",
    "agent_modes",
    "device_agent_settings",
    "user_agent_defaults",
)


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "legacy_import_archive" not in tables:
        op.create_table(
            "legacy_import_archive",
            sa.Column("source_table", sa.Text(), nullable=False),
            sa.Column("row_key", sa.Text(), nullable=False),
            sa.Column("payload_json", sa.Text(), nullable=False),
            sa.Column("archived_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("source_table", "row_key"),
        )
    if "device_agent_settings" in tables:
        _migrate_runtime_settings(bind)
    if "sessions" in tables and "runtime_settings_override" in _column_names(
        bind, "sessions"
    ):
        _migrate_session_selections(bind)
    _archive_legacy_data(bind, tables)


def downgrade() -> None:
    raise RuntimeError("downgrading v2.2 would discard migrated legacy settings")


def _migrate_runtime_settings(bind) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT connector_id, runtime, settings_json FROM device_agent_settings"
        )
    ).mappings()
    for row in rows:
        raw = row["settings_json"]
        if not isinstance(raw, str) or _load_json(raw) is None:
            continue
        bind.execute(
            sa.text(
                "UPDATE device_runtimes SET config_json = :config_json "
                "WHERE connector_id = :connector_id AND runtime_id = :runtime_id"
            ),
            {
                "connector_id": row["connector_id"],
                "runtime_id": row["runtime"],
                "config_json": raw,
            },
        )


def _migrate_session_selections(bind) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT id, runtime_settings_override, model_selection_id, "
            "permission_selection_id FROM sessions "
            "WHERE runtime_settings_override IS NOT NULL"
        )
    ).mappings()
    for row in rows:
        settings = _load_json(row["runtime_settings_override"])
        if not isinstance(settings, dict):
            continue
        model = _selection(settings.get("model"))
        permission = _selection(
            settings.get("permissionMode") or settings.get("permission")
        )
        bind.execute(
            sa.text(
                "UPDATE sessions SET "
                "model_selection_id = COALESCE(model_selection_id, :model), "
                "permission_selection_id = COALESCE(permission_selection_id, :permission) "
                "WHERE id = :session_id"
            ),
            {
                "session_id": row["id"],
                "model": model,
                "permission": permission,
            },
        )


def _archive_legacy_data(bind, tables: set[str]) -> None:
    archived_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    for table_name in _LEGACY_TABLES:
        if table_name not in tables:
            continue
        rows = bind.execute(sa.text(f'SELECT * FROM "{table_name}"')).mappings()
        for row in rows:
            _archive_row(bind, table_name, dict(row), archived_at)

    if "connectors" in tables and "runtime_capabilities" in _column_names(
        bind, "connectors"
    ):
        rows = bind.execute(
            sa.text(
                "SELECT id, runtime_capabilities FROM connectors "
                "WHERE runtime_capabilities IS NOT NULL"
            )
        ).mappings()
        for row in rows:
            _archive_row(
                bind,
                "connectors.runtime_capabilities",
                dict(row),
                archived_at,
            )

    if "sessions" in tables and "runtime_settings_override" in _column_names(
        bind, "sessions"
    ):
        rows = bind.execute(
            sa.text(
                "SELECT id, runtime_settings_override FROM sessions "
                "WHERE runtime_settings_override IS NOT NULL"
            )
        ).mappings()
        for row in rows:
            _archive_row(
                bind,
                "sessions.runtime_settings_override",
                dict(row),
                archived_at,
            )


def _archive_row(
    bind,
    source_table: str,
    payload: dict[str, Any],
    archived_at: str,
) -> None:
    payload_json = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    row_key = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    bind.execute(
        sa.text(
            "INSERT INTO legacy_import_archive "
            "(source_table, row_key, payload_json, archived_at) "
            "VALUES (:source_table, :row_key, :payload_json, :archived_at)"
        ),
        {
            "source_table": source_table,
            "row_key": row_key,
            "payload_json": payload_json,
            "archived_at": archived_at,
        },
    )


def _column_names(bind, table: str) -> set[str]:
    return {str(column["name"]) for column in sa.inspect(bind).get_columns(table)}


def _load_json(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _selection(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None
