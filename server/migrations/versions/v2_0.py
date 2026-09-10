"""Create the strict v2.0 schema and preserve legacy v1 data.

Revision ID: v2_0
Revises: v1_legacy
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op

from migrations.schema_v2_0 import device_runtimes, metadata

revision: str = "v2_0"
down_revision: str | None = "v1_legacy"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    metadata.create_all(bind=bind)
    _add_session_selection_columns(bind)
    bind.execute(
        sa.text(
            "UPDATE sessions SET status = 'blocked' "
            "WHERE status IN ('waiting_approval', 'error')"
        )
    )
    _migrate_device_runtimes(bind)


def downgrade() -> None:
    raise RuntimeError("downgrading the v2.0 schema to an unversioned v1 database is not supported")


def _add_session_selection_columns(bind) -> None:
    columns = _column_names(bind, "sessions")
    if "model_selection_id" not in columns:
        op.add_column("sessions", sa.Column("model_selection_id", sa.Text(), nullable=True))
    if "permission_selection_id" not in columns:
        op.add_column("sessions", sa.Column("permission_selection_id", sa.Text(), nullable=True))


def _migrate_device_runtimes(bind) -> None:
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "connectors" not in tables or "runtime_capabilities" not in _column_names(bind, "connectors"):
        return

    settings_by_runtime: dict[tuple[str, str], dict[str, Any]] = {}
    if "device_agent_settings" in tables:
        rows = bind.execute(
            sa.text(
                "SELECT connector_id, runtime, settings_json "
                "FROM device_agent_settings"
            )
        ).mappings()
        for row in rows:
            settings_by_runtime[(str(row["connector_id"]), str(row["runtime"]))] = (
                _load_json(row["settings_json"]) or {}
            )

    existing = {
        (str(row.connector_id), str(row.runtime_id))
        for row in bind.execute(
            sa.select(device_runtimes.c.connector_id, device_runtimes.c.runtime_id)
        )
    }
    connectors = bind.execute(
        sa.text(
            "SELECT id, runtime_capabilities, updated_at FROM connectors"
        )
    ).mappings()
    for connector in connectors:
        connector_id = str(connector["id"])
        state = _normalize_agents_blob(_load_json(connector["runtime_capabilities"]))
        observed = state["observed"]
        desired = state["desired"]
        runtime_ids = set(observed) | set(desired)
        runtime_ids.update(
            runtime for stored_connector, runtime in settings_by_runtime if stored_connector == connector_id
        )
        for runtime_id in sorted(runtime_ids):
            if (connector_id, runtime_id) in existing:
                continue
            observation = observed.get(runtime_id)
            report = observation.get("report") if isinstance(observation, dict) else None
            report = report if isinstance(report, dict) else {}
            intent = desired.get(runtime_id)
            active = isinstance(intent, dict) and intent.get("enabled") is True
            has_settings = (connector_id, runtime_id) in settings_by_runtime
            observed_at = observation.get("observedAt") if isinstance(observation, dict) else None
            updated_at = (
                observed_at
                or state.get("lastDiscoveredAt")
                or connector["updated_at"]
                or _utc_now()
            )
            bind.execute(
                sa.insert(device_runtimes).values(
                    connector_id=connector_id,
                    runtime_id=runtime_id,
                    runtime_type=runtime_id,
                    display_name=_display_name(runtime_id),
                    present=1 if report else 0,
                    discovery_json=_dump_json(report),
                    config_schema_json=None,
                    ui_schema_json="{}",
                    config_json="{}" if active or has_settings else None,
                    active=1 if active else 0,
                    status="unknown" if active else "stopped",
                    error_json=None,
                    last_discovered_at=str(updated_at),
                    updated_at=str(updated_at),
                )
            )


def _normalize_agents_blob(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"lastDiscoveredAt": None, "observed": {}, "desired": {}}
    if raw.get("version") == 3:
        return {
            "lastDiscoveredAt": raw.get("lastDiscoveredAt"),
            "observed": dict(raw.get("observed") or {}),
            "desired": dict(raw.get("desired") or {}),
        }
    if raw.get("version") == 2:
        observed: dict[str, Any] = {}
        desired: dict[str, Any] = {}
        for runtime_id, attached in dict(raw.get("attached") or {}).items():
            if not isinstance(attached, dict):
                continue
            report = attached.get("report")
            if isinstance(report, dict):
                observed[str(runtime_id)] = {
                    "report": report,
                    "observedAt": raw.get("lastDiscoveredAt"),
                }
            desired[str(runtime_id)] = {
                "enabled": True,
                "updatedAt": attached.get("attachedAt") or raw.get("lastDiscoveredAt"),
            }
        for runtime_id in list(raw.get("disabled") or []):
            desired[str(runtime_id)] = {"enabled": False, "updatedAt": raw.get("lastDiscoveredAt")}
        return {"lastDiscoveredAt": raw.get("lastDiscoveredAt"), "observed": observed, "desired": desired}

    observed = {}
    desired = {}
    observed_at = raw.get("checkedAt")
    for runtime_id, report in dict(raw.get("runtimes") or {}).items():
        if not isinstance(report, dict):
            continue
        runtime_id = str(runtime_id)
        observed[runtime_id] = {"report": report, "observedAt": observed_at}
        if report.get("selected") or any(
            isinstance(item, dict) and item.get("status") == "failed"
            for item in list(report.get("checked") or [])
        ):
            desired[runtime_id] = {"enabled": True, "updatedAt": observed_at}
    return {"lastDiscoveredAt": observed_at, "observed": observed, "desired": desired}


def _column_names(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return set()
    return {str(column["name"]) for column in inspector.get_columns(table)}


def _load_json(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _display_name(runtime_id: str) -> str:
    labels = {"codex": "Codex", "claude": "Claude", "opencode": "OpenCode", "acp": "ACP"}
    return labels.get(runtime_id, runtime_id.replace("_", " ").replace("-", " ").title())


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
