"""Split runtime discovery types from named runtime instances.

Revision ID: v2_14
Revises: v2_13
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "v2_14"
down_revision: str | None = "v2_13"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EMPTY_JSON = "{}"
_OLD_DEVICE_RUNTIMES = "device_runtimes"
_NEW_DEVICE_RUNTIMES = "device_runtimes_v2_14"
_DOWNGRADE_DEVICE_RUNTIMES = "device_runtimes_v2_13"
_OLD_RUNTIME_CATALOGS = "connector_runtime_catalogs"
_NEW_RUNTIME_CATALOGS = "connector_runtime_catalogs_v2_14"
_DOWNGRADE_RUNTIME_CATALOGS = "connector_runtime_catalogs_v2_13"
_WHITESPACE_RE = re.compile(r"\s+")


def upgrade() -> None:
    bind = op.get_bind()

    op.add_column(
        "connectors",
        sa.Column(
            "runtime_control_version",
            sa.Text(),
            nullable=False,
            server_default="1.0",
        ),
    )
    _create_runtime_type_table()
    _create_instance_table(_NEW_DEVICE_RUNTIMES)
    _migrate_runtime_inventory(bind)
    op.drop_table(_OLD_DEVICE_RUNTIMES)
    op.rename_table(_NEW_DEVICE_RUNTIMES, _OLD_DEVICE_RUNTIMES)

    _add_runtime_id("sessions")
    _add_runtime_id("session_active_runs")
    _create_runtime_catalog_table(_NEW_RUNTIME_CATALOGS)
    bind.execute(
        sa.text(
            "INSERT INTO connector_runtime_catalogs_v2_14 "
            "(connector_id, runtime, runtime_id, catalog_type, revision, "
            "catalog_json, updated_at) "
            "SELECT connector_id, runtime, runtime, catalog_type, revision, "
            "catalog_json, updated_at FROM connector_runtime_catalogs"
        )
    )
    op.drop_table(_OLD_RUNTIME_CATALOGS)
    op.rename_table(_NEW_RUNTIME_CATALOGS, _OLD_RUNTIME_CATALOGS)


def downgrade() -> None:
    bind = op.get_bind()
    _reject_incompatible_downgrade(bind)

    _create_runtime_catalog_table_v2_13(_DOWNGRADE_RUNTIME_CATALOGS)
    bind.execute(
        sa.text(
            "INSERT INTO connector_runtime_catalogs_v2_13 "
            "(connector_id, runtime, catalog_type, revision, catalog_json, updated_at) "
            "SELECT connector_id, runtime, catalog_type, revision, catalog_json, updated_at "
            "FROM connector_runtime_catalogs"
        )
    )
    op.drop_table(_OLD_RUNTIME_CATALOGS)
    op.rename_table(_DOWNGRADE_RUNTIME_CATALOGS, _OLD_RUNTIME_CATALOGS)

    op.drop_column("session_active_runs", "runtime_id")
    op.drop_column("sessions", "runtime_id")

    _create_runtime_table_v2_13(_DOWNGRADE_DEVICE_RUNTIMES)
    runtime_types = _runtime_type_table()
    instances = _instance_table(_OLD_DEVICE_RUNTIMES)
    old_runtimes = _runtime_table_v2_13(_DOWNGRADE_DEVICE_RUNTIMES)

    type_rows = {
        (str(row["connector_id"]), str(row["runtime_type"])): row
        for row in bind.execute(sa.select(runtime_types)).mappings()
    }
    instance_rows = bind.execute(sa.select(instances)).mappings().all()
    restored_types: set[tuple[str, str]] = set()
    restored_ids: set[tuple[str, str]] = set()
    for row in instance_rows:
        key = (str(row["connector_id"]), str(row["runtime_type"]))
        descriptor = type_rows[key]
        restored_types.add(key)
        restored_ids.add((str(row["connector_id"]), str(row["runtime_id"])))
        bind.execute(
            old_runtimes.insert().values(
                connector_id=row["connector_id"],
                runtime_id=row["runtime_id"],
                runtime_type=descriptor["implementation_type"],
                display_name=row["name"],
                present=descriptor["present"],
                discovery_json=descriptor["discovery_json"],
                inventory_metadata_json=descriptor["metadata_json"],
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

    for key, descriptor in sorted(type_rows.items()):
        connector_id, runtime_type = key
        if key in restored_types or (connector_id, runtime_type) in restored_ids:
            continue
        bind.execute(
            old_runtimes.insert().values(
                connector_id=connector_id,
                runtime_id=runtime_type,
                runtime_type=descriptor["implementation_type"],
                display_name=descriptor["display_name"],
                present=descriptor["present"],
                discovery_json=descriptor["discovery_json"],
                inventory_metadata_json=descriptor["metadata_json"],
                config_schema_json=descriptor["config_schema_json"],
                ui_schema_json=descriptor["ui_schema_json"],
                config_json=None,
                active=0,
                status=(
                    "available" if bool(descriptor["available"]) else "unavailable"
                ),
                error_json=None,
                last_discovered_at=descriptor["last_discovered_at"],
                updated_at=descriptor["updated_at"],
            )
        )

    op.drop_table(_OLD_DEVICE_RUNTIMES)
    op.drop_table("connector_runtime_types")
    op.rename_table(_DOWNGRADE_DEVICE_RUNTIMES, _OLD_DEVICE_RUNTIMES)
    op.drop_column("connectors", "runtime_control_version")


def _migrate_runtime_inventory(bind: Any) -> None:
    old_runtimes = _runtime_table_v2_13(_OLD_DEVICE_RUNTIMES)
    runtime_types = _runtime_type_table()
    new_runtimes = _instance_table(_NEW_DEVICE_RUNTIMES)
    rows = sorted(
        bind.execute(sa.select(old_runtimes)).mappings().all(),
        key=lambda row: (str(row["connector_id"]), str(row["runtime_id"])),
    )
    used_names: dict[str, set[str]] = {}

    for row in rows:
        connector_id = str(row["connector_id"])
        runtime_type = str(row["runtime_id"])
        present = bool(row["present"])
        available = present and str(row["status"]) != "unavailable"
        name = _unique_instance_name(
            connector_id=connector_id,
            display_name=str(row["display_name"]),
            runtime_id=runtime_type,
            used_names=used_names,
        )
        bind.execute(
            runtime_types.insert().values(
                connector_id=connector_id,
                runtime_type=runtime_type,
                implementation_type=row["runtime_type"],
                display_name=row["display_name"],
                description=None,
                present=1 if present else 0,
                available=1 if available else 0,
                reason=(
                    None
                    if available
                    else "runtime_unavailable" if present else "not_discovered"
                ),
                recommended=0,
                recommendation_rank=None,
                discovery_json=row["discovery_json"] or _EMPTY_JSON,
                config_schema_json=row["config_schema_json"],
                ui_schema_json=row["ui_schema_json"],
                defaults_json=_EMPTY_JSON,
                capabilities_json=_EMPTY_JSON,
                metadata_json=row["inventory_metadata_json"] or _EMPTY_JSON,
                instance_policy="single",
                max_instances=1,
                last_discovered_at=row["last_discovered_at"],
                created_at=row["updated_at"],
                updated_at=row["updated_at"],
            )
        )
        bind.execute(
            new_runtimes.insert().values(
                connector_id=connector_id,
                runtime_id=runtime_type,
                runtime_type=runtime_type,
                name=name,
                name_key=_name_key(name),
                config_json=row["config_json"],
                active=row["active"],
                status=row["status"],
                error_json=row["error_json"],
                created_at=row["updated_at"],
                updated_at=row["updated_at"],
            )
        )


def _add_runtime_id(table_name: str) -> None:
    op.add_column(table_name, sa.Column("runtime_id", sa.Text(), nullable=True))
    op.execute(sa.text(f"UPDATE {table_name} SET runtime_id = runtime"))
    op.alter_column(
        table_name,
        "runtime_id",
        existing_type=sa.Text(),
        nullable=False,
    )


def _reject_incompatible_downgrade(bind: Any) -> None:
    checks = (
        (
            "device_runtimes",
            "runtime_id <> runtime_type",
            "named runtime instances",
        ),
        ("sessions", "runtime_id <> runtime", "session instance bindings"),
        (
            "session_active_runs",
            "runtime_id <> runtime",
            "active-run instance bindings",
        ),
        (
            "connector_runtime_catalogs",
            "runtime_id <> runtime",
            "runtime catalog instance bindings",
        ),
    )
    for table_name, predicate, description in checks:
        found = bind.execute(
            sa.text(f"SELECT 1 FROM {table_name} WHERE {predicate} LIMIT 1")
        ).first()
        if found is not None:
            raise RuntimeError(
                f"cannot downgrade v2_14 while {description} are present"
            )


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
        sa.Column("implementation_type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("present", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("available", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("reason", sa.Text()),
        sa.Column("recommended", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recommendation_rank", sa.Integer()),
        sa.Column("discovery_json", sa.Text(), nullable=False),
        sa.Column("config_schema_json", sa.Text()),
        sa.Column("ui_schema_json", sa.Text()),
        sa.Column("defaults_json", sa.Text(), nullable=False),
        sa.Column("capabilities_json", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.Text(), nullable=False),
        sa.Column("instance_policy", sa.Text(), nullable=False),
        sa.Column("max_instances", sa.BigInteger()),
        sa.Column("last_discovered_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
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
        sa.Column("config_json", sa.Text()),
        sa.Column("active", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.Text(), nullable=False, server_default="stopped"),
        sa.Column("error_json", sa.Text()),
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


def _create_runtime_catalog_table(name: str) -> None:
    op.create_table(
        name,
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("runtime", sa.Text(), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("catalog_type", sa.Text(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("catalog_json", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id", "catalog_type"),
    )


def _create_runtime_catalog_table_v2_13(name: str) -> None:
    op.create_table(
        name,
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("runtime", sa.Text(), nullable=False),
        sa.Column("catalog_type", sa.Text(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("catalog_json", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime", "catalog_type"),
    )


def _create_runtime_table_v2_13(name: str) -> None:
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
        sa.Column(
            "inventory_metadata_json",
            sa.Text(),
            nullable=False,
            server_default=_EMPTY_JSON,
        ),
        sa.Column("config_schema_json", sa.Text()),
        sa.Column("ui_schema_json", sa.Text()),
        sa.Column("config_json", sa.Text()),
        sa.Column("active", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.Text(), nullable=False, server_default="stopped"),
        sa.Column("error_json", sa.Text()),
        sa.Column("last_discovered_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id"),
    )


def _runtime_type_table() -> sa.Table:
    return sa.table(
        "connector_runtime_types",
        sa.column("connector_id", sa.Text()),
        sa.column("runtime_type", sa.Text()),
        sa.column("implementation_type", sa.Text()),
        sa.column("display_name", sa.Text()),
        sa.column("description", sa.Text()),
        sa.column("present", sa.Integer()),
        sa.column("available", sa.Integer()),
        sa.column("reason", sa.Text()),
        sa.column("recommended", sa.Integer()),
        sa.column("recommendation_rank", sa.Integer()),
        sa.column("discovery_json", sa.Text()),
        sa.column("config_schema_json", sa.Text()),
        sa.column("ui_schema_json", sa.Text()),
        sa.column("defaults_json", sa.Text()),
        sa.column("capabilities_json", sa.Text()),
        sa.column("metadata_json", sa.Text()),
        sa.column("instance_policy", sa.Text()),
        sa.column("max_instances", sa.BigInteger()),
        sa.column("last_discovered_at", sa.Text()),
        sa.column("created_at", sa.Text()),
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


def _runtime_table_v2_13(name: str) -> sa.Table:
    return sa.table(
        name,
        sa.column("connector_id", sa.Text()),
        sa.column("runtime_id", sa.Text()),
        sa.column("runtime_type", sa.Text()),
        sa.column("display_name", sa.Text()),
        sa.column("present", sa.Integer()),
        sa.column("discovery_json", sa.Text()),
        sa.column("inventory_metadata_json", sa.Text()),
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
    base = _WHITESPACE_RE.sub(" ", display_name.strip()) or runtime_id
    candidate = base
    key = _name_key(candidate)
    suffix = 1
    while key in names:
        marker = runtime_id if suffix == 1 else f"{runtime_id}-{suffix}"
        candidate = f"{base} ({marker})"
        key = _name_key(candidate)
        suffix += 1
    names.add(key)
    return candidate
