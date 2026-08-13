"""Split runtime type discovery from named runtime instances.

Revision ID: v2_11
Revises: v2_10
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "v2_11"
down_revision: str | None = "v2_10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EMPTY_JSON = "{}"
_OLD_DEVICE_RUNTIMES = "device_runtimes"
_NEW_DEVICE_RUNTIMES = "device_runtimes_v2_11"
_DOWNGRADE_DEVICE_RUNTIMES = "device_runtimes_v2_10"
_WHITESPACE_RE = re.compile(r"\s+")


def upgrade() -> None:
    bind = op.get_bind()
    _create_runtime_type_table()
    _create_instance_table(_NEW_DEVICE_RUNTIMES)

    old_runtimes = _old_runtime_table(_OLD_DEVICE_RUNTIMES)
    runtime_types = _runtime_type_table()
    new_runtimes = _instance_table(_NEW_DEVICE_RUNTIMES)
    rows = bind.execute(sa.select(old_runtimes)).mappings().all()

    type_rows: dict[tuple[str, str], Mapping[str, Any]] = {}
    for row in rows:
        key = (str(row["connector_id"]), str(row["runtime_type"]))
        previous = type_rows.get(key)
        if previous is None or _discovery_order(row) >= _discovery_order(previous):
            type_rows[key] = row

    for row in type_rows.values():
        bind.execute(
            runtime_types.insert().values(
                connector_id=row["connector_id"],
                runtime_type=row["runtime_type"],
                display_name=row["display_name"],
                description=None,
                available=1 if row["present"] else 0,
                recommended=0,
                recommendation_rank=None,
                discovery_json=row["discovery_json"] or _EMPTY_JSON,
                config_schema_json=row["config_schema_json"],
                ui_schema_json=row["ui_schema_json"],
                defaults_json=_EMPTY_JSON,
                capabilities_json=_EMPTY_JSON,
                metadata_json=_EMPTY_JSON,
                last_discovered_at=row["last_discovered_at"],
                updated_at=row["updated_at"],
            )
        )

    referenced = {
        (str(row["connector_id"]), str(row["runtime"]))
        for row in bind.execute(
            sa.text("SELECT DISTINCT connector_id, runtime FROM sessions")
        ).mappings()
    }
    used_names: dict[str, set[str]] = {}
    for row in rows:
        configured = row["config_json"] is not None
        key = (str(row["connector_id"]), str(row["runtime_id"]))
        if not configured and key not in referenced:
            continue
        name = _unique_instance_name(
            connector_id=str(row["connector_id"]),
            display_name=str(row["display_name"]),
            runtime_id=str(row["runtime_id"]),
            used_names=used_names,
        )
        bind.execute(
            new_runtimes.insert().values(
                connector_id=row["connector_id"],
                runtime_id=row["runtime_id"],
                runtime_type=row["runtime_type"],
                name=name,
                name_key=_name_key(name),
                config_json=row["config_json"],
                active=1 if configured and row["active"] else 0,
                status=row["status"] if configured else "stopped",
                error_json=row["error_json"] if configured else None,
                created_at=row["updated_at"],
                updated_at=row["updated_at"],
            )
        )

    op.drop_table(_OLD_DEVICE_RUNTIMES)
    op.rename_table(_NEW_DEVICE_RUNTIMES, _OLD_DEVICE_RUNTIMES)


def downgrade() -> None:
    bind = op.get_bind()
    _create_old_runtime_table(_DOWNGRADE_DEVICE_RUNTIMES)

    runtime_types = _runtime_type_table()
    instances = _instance_table(_OLD_DEVICE_RUNTIMES)
    old_runtimes = _old_runtime_table(_DOWNGRADE_DEVICE_RUNTIMES)
    type_rows = {
        (str(row["connector_id"]), str(row["runtime_type"])): row
        for row in bind.execute(sa.select(runtime_types)).mappings()
    }
    instance_rows = bind.execute(sa.select(instances)).mappings().all()
    occupied_types: set[tuple[str, str]] = set()
    occupied_ids = {
        (str(row["connector_id"]), str(row["runtime_id"]))
        for row in instance_rows
    }

    for row in instance_rows:
        key = (str(row["connector_id"]), str(row["runtime_type"]))
        descriptor = type_rows[key]
        occupied_types.add(key)
        bind.execute(
            old_runtimes.insert().values(
                connector_id=row["connector_id"],
                runtime_id=row["runtime_id"],
                runtime_type=row["runtime_type"],
                display_name=row["name"],
                present=descriptor["available"],
                discovery_json=descriptor["discovery_json"],
                config_schema_json=descriptor["config_schema_json"],
                ui_schema_json=descriptor["ui_schema_json"],
                config_json=row["config_json"],
                active=row["active"],
                status=row["status"],
                error_json=row["error_json"],
                last_discovered_at=descriptor["last_discovered_at"],
                updated_at=row["updated_at"],
            )
        )

    for key, descriptor in type_rows.items():
        connector_id, runtime_type = key
        if (
            (connector_id, runtime_type) in occupied_types
            or (connector_id, runtime_type) in occupied_ids
        ):
            continue
        bind.execute(
            old_runtimes.insert().values(
                connector_id=connector_id,
                runtime_id=runtime_type,
                runtime_type=runtime_type,
                display_name=descriptor["display_name"],
                present=descriptor["available"],
                discovery_json=descriptor["discovery_json"],
                config_schema_json=descriptor["config_schema_json"],
                ui_schema_json=descriptor["ui_schema_json"],
                config_json=None,
                active=0,
                status="available" if descriptor["available"] else "unavailable",
                error_json=None,
                last_discovered_at=descriptor["last_discovered_at"],
                updated_at=descriptor["updated_at"],
            )
        )

    op.drop_table(_OLD_DEVICE_RUNTIMES)
    op.drop_table("connector_runtime_types")
    op.rename_table(_DOWNGRADE_DEVICE_RUNTIMES, _OLD_DEVICE_RUNTIMES)


def _create_runtime_type_table() -> None:
    op.create_table(
        "connector_runtime_types",
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("runtime_type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("available", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recommended", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recommendation_rank", sa.Integer(), nullable=True),
        sa.Column("discovery_json", sa.Text(), nullable=False),
        sa.Column("config_schema_json", sa.Text(), nullable=True),
        sa.Column("ui_schema_json", sa.Text(), nullable=True),
        sa.Column("defaults_json", sa.Text(), nullable=False),
        sa.Column("capabilities_json", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.Text(), nullable=False),
        sa.Column("last_discovered_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_type"),
    )


def _create_instance_table(name: str) -> None:
    op.create_table(
        name,
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("runtime_type", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("name_key", sa.Text(), nullable=False),
        sa.Column("config_json", sa.Text(), nullable=True),
        sa.Column("active", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.Text(), nullable=False, server_default="stopped"),
        sa.Column("error_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id"),
        sa.UniqueConstraint("connector_id", "name_key"),
        sa.ForeignKeyConstraint(
            ["connector_id", "runtime_type"],
            [
                "connector_runtime_types.connector_id",
                "connector_runtime_types.runtime_type",
            ],
            ondelete="CASCADE",
        ),
    )


def _create_old_runtime_table(name: str) -> None:
    op.create_table(
        name,
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("runtime_type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("present", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("discovery_json", sa.Text(), nullable=False),
        sa.Column("config_schema_json", sa.Text(), nullable=True),
        sa.Column("ui_schema_json", sa.Text(), nullable=True),
        sa.Column("config_json", sa.Text(), nullable=True),
        sa.Column("active", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.Text(), nullable=False, server_default="stopped"),
        sa.Column("error_json", sa.Text(), nullable=True),
        sa.Column("last_discovered_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id"),
    )


def _runtime_type_table() -> sa.Table:
    return sa.table(
        "connector_runtime_types",
        sa.column("connector_id", sa.Text()),
        sa.column("runtime_type", sa.Text()),
        sa.column("display_name", sa.Text()),
        sa.column("description", sa.Text()),
        sa.column("available", sa.Integer()),
        sa.column("recommended", sa.Integer()),
        sa.column("recommendation_rank", sa.Integer()),
        sa.column("discovery_json", sa.Text()),
        sa.column("config_schema_json", sa.Text()),
        sa.column("ui_schema_json", sa.Text()),
        sa.column("defaults_json", sa.Text()),
        sa.column("capabilities_json", sa.Text()),
        sa.column("metadata_json", sa.Text()),
        sa.column("last_discovered_at", sa.Text()),
        sa.column("updated_at", sa.Text()),
    )


def _instance_table(name: str) -> sa.Table:
    return sa.table(
        name,
        sa.column("connector_id", sa.Text()),
        sa.column("runtime_id", sa.Text()),
        sa.column("runtime_type", sa.Text()),
        sa.column("name", sa.Text()),
        sa.column("name_key", sa.Text()),
        sa.column("config_json", sa.Text()),
        sa.column("active", sa.Integer()),
        sa.column("status", sa.Text()),
        sa.column("error_json", sa.Text()),
        sa.column("created_at", sa.Text()),
        sa.column("updated_at", sa.Text()),
    )


def _old_runtime_table(name: str) -> sa.Table:
    return sa.table(
        name,
        sa.column("connector_id", sa.Text()),
        sa.column("runtime_id", sa.Text()),
        sa.column("runtime_type", sa.Text()),
        sa.column("display_name", sa.Text()),
        sa.column("present", sa.Integer()),
        sa.column("discovery_json", sa.Text()),
        sa.column("config_schema_json", sa.Text()),
        sa.column("ui_schema_json", sa.Text()),
        sa.column("config_json", sa.Text()),
        sa.column("active", sa.Integer()),
        sa.column("status", sa.Text()),
        sa.column("error_json", sa.Text()),
        sa.column("last_discovered_at", sa.Text()),
        sa.column("updated_at", sa.Text()),
    )


def _name_key(name: str) -> str:
    normalized = unicodedata.normalize("NFKC", name).strip()
    return _WHITESPACE_RE.sub(" ", normalized).casefold()


def _unique_instance_name(
    *,
    connector_id: str,
    display_name: str,
    runtime_id: str,
    used_names: dict[str, set[str]],
) -> str:
    names = used_names.setdefault(connector_id, set())
    candidate = display_name.strip() or runtime_id
    key = _name_key(candidate)
    suffix = 1
    while key in names:
        marker = runtime_id if suffix == 1 else f"{runtime_id}-{suffix}"
        candidate = f"{display_name.strip() or runtime_id} ({marker})"
        key = _name_key(candidate)
        suffix += 1
    names.add(key)
    return candidate


def _discovery_order(row: Mapping[str, Any]) -> tuple[str, str, str]:
    return (
        str(row["last_discovered_at"]),
        str(row["updated_at"]),
        str(row["runtime_id"]),
    )
