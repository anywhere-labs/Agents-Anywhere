"""Add Android application release metadata.

Revision ID: v2_15
Revises: v2_14
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op


revision: str = "v2_15"
down_revision: str | None = "v2_14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "app_releases" in tables:
        return
    if "android_app_releases" not in tables:
        op.create_table(
            "android_app_releases",
            sa.Column("version_code", sa.Integer(), primary_key=True),
            sa.Column("version_name", sa.Text(), nullable=False),
            sa.Column("download_url", sa.Text()),
            sa.Column("sha256", sa.Text()),
            sa.Column("published", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )

    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    table = sa.table(
        "android_app_releases",
        sa.column("version_code", sa.Integer()),
        sa.column("version_name", sa.Text()),
        sa.column("download_url", sa.Text()),
        sa.column("sha256", sa.Text()),
        sa.column("published", sa.Integer()),
        sa.column("created_at", sa.Text()),
        sa.column("updated_at", sa.Text()),
    )
    existing = op.get_bind().execute(
        sa.select(table.c.version_code).where(table.c.version_code == 6)
    ).first()
    if existing is None:
        op.bulk_insert(
            table,
            [
                {
                    "version_code": 6,
                    "version_name": "0.1.7.2",
                    "download_url": None,
                    "sha256": None,
                    "published": 1,
                    "created_at": now,
                    "updated_at": now,
                }
            ],
        )


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "android_app_releases" in tables:
        op.drop_table("android_app_releases")
