"""Generalize application releases by platform.

Revision ID: v2_15
Revises: v2_14
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_15"
down_revision: str | None = "v2_14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "app_releases" not in inspector.get_table_names():
        op.create_table(
            "app_releases",
            sa.Column("platform", sa.Text(), nullable=False),
            sa.Column("version_code", sa.Integer(), nullable=False),
            sa.Column("version_name", sa.Text(), nullable=False),
            sa.Column("download_url", sa.Text()),
            sa.Column("sha256", sa.Text()),
            sa.Column("published", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("platform", "version_code"),
        )

    inspector = sa.inspect(op.get_bind())
    if "android_app_releases" in inspector.get_table_names():
        op.execute(
            sa.text(
                """
                INSERT INTO app_releases (
                    platform, version_code, version_name, download_url,
                    sha256, published, created_at, updated_at
                )
                SELECT
                    'android', version_code, version_name, download_url,
                    sha256, published, created_at, updated_at
                FROM android_app_releases
                """
            )
        )
        op.drop_table("android_app_releases")


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "android_app_releases" not in inspector.get_table_names():
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
    op.execute(
        sa.text(
            """
            INSERT INTO android_app_releases (
                version_code, version_name, download_url, sha256,
                published, created_at, updated_at
            )
            SELECT
                version_code, version_name, download_url, sha256,
                published, created_at, updated_at
            FROM app_releases
            WHERE platform = 'android'
            """
        )
    )
    op.drop_table("app_releases")
