"""Retire client release storage while preserving its history.

Revision ID: v2_32
Revises: v2_31
"""

from alembic import op

revision = "v2_32"
down_revision = "v2_31"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.rename_table("app_releases", "_deprecated_app_releases")


def downgrade() -> None:
    op.rename_table("_deprecated_app_releases", "app_releases")
