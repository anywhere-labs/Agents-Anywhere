"""Model channels: the user's current channel, per-runtime overrides and switches.

Revision ID: v2_51
Revises: v2_50
"""

from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "v2_51"
down_revision = "v2_50"
branch_labels = None
depends_on = None


def _runtime_key() -> list[Any]:
    return [
        sa.Column("connector_id", sa.Text(), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
    ]


def _runtime_constraints() -> list[Any]:
    return [
        sa.PrimaryKeyConstraint("connector_id", "runtime_id"),
        sa.ForeignKeyConstraint(
            ["connector_id", "runtime_id"],
            ["device_runtimes.connector_id", "device_runtimes.runtime_id"],
            ondelete="CASCADE",
        ),
    ]


def upgrade() -> None:
    # Applying a profile runtime by runtime is replaced by one current channel.
    op.drop_table("model_config_operations")
    op.create_table(
        "model_channel_selections",
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
    op.create_table(
        "runtime_channel_overrides",
        *_runtime_key(),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("confirm_native_global", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.Text(), nullable=False),
        *_runtime_constraints(),
    )
    # One row per runtime: the switch in progress or the last one's outcome,
    # with the sealed snapshot a failed switch is rolled back to.
    op.create_table(
        "runtime_channel_switches",
        *_runtime_key(),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("step", sa.Text()),
        sa.Column("target_channel", sa.Text()),
        sa.Column("reason", sa.Text()),
        sa.Column("message", sa.Text()),
        sa.Column("snapshot_ciphertext", sa.Text()),
        sa.Column("switch_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("operation_id", sa.Text()),
        sa.Column("lease_until", sa.Text()),
        sa.Column("started_at", sa.Text()),
        sa.Column("updated_at", sa.Text(), nullable=False),
        *_runtime_constraints(),
    )
    op.create_index("idx_runtime_channel_switches_user_id", "runtime_channel_switches", ["user_id"])
    # Requests admitted to a runtime that have not started their task yet; a
    # switch closes admission before immediately replacing the runtime.
    op.create_table(
        "runtime_admissions",
        sa.Column("token", sa.Text(), primary_key=True),
        sa.Column("connector_id", sa.Text(), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
    )
    op.create_index("idx_runtime_admissions_runtime", "runtime_admissions", ["connector_id", "runtime_id"])


def downgrade() -> None:
    op.drop_index("idx_runtime_admissions_runtime", table_name="runtime_admissions")
    op.drop_table("runtime_admissions")
    op.drop_index("idx_runtime_channel_switches_user_id", table_name="runtime_channel_switches")
    op.drop_table("runtime_channel_switches")
    op.drop_table("runtime_channel_overrides")
    op.drop_table("model_channel_selections")
    op.create_table(
        "model_config_operations",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_digest", sa.Text(), nullable=False),
        sa.Column("targets_json", sa.Text(), nullable=False),
        sa.Column("lease_until", sa.Text(), nullable=False),
        sa.Column("result_json", sa.Text()),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("finished_at", sa.Text()),
        sa.UniqueConstraint("user_id", "idempotency_key"),
    )
