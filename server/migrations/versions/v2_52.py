"""Durable channel reconciliation and notification outbox.

Revision ID: v2_52
Revises: v2_51
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_52"
down_revision = "v2_51"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_profiles",
        sa.Column(
            "connection_revision", sa.BigInteger(), nullable=False, server_default="1"
        ),
    )
    op.alter_column(
        "runtime_channel_switches", "switch_revision", type_=sa.BigInteger()
    )
    op.add_column(
        "runtime_channel_switches", sa.Column("target_generation", sa.BigInteger())
    )
    op.add_column(
        "runtime_channel_switches", sa.Column("target_spec_digest", sa.Text())
    )
    op.add_column(
        "runtime_channel_switches", sa.Column("expected_config_digest", sa.Text())
    )
    op.add_column("runtime_channel_switches", sa.Column("plan_ciphertext", sa.Text()))
    op.add_column("runtime_channel_switches", sa.Column("lease_owner", sa.Text()))
    op.add_column(
        "runtime_channel_switches",
        sa.Column("lease_epoch", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.execute(
        """
        CREATE TABLE runtime_channel_sync (
            connector_id TEXT NOT NULL,
            runtime_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            desired_generation BIGINT DEFAULT '1' NOT NULL,
            desired_channel TEXT NOT NULL,
            desired_spec_digest TEXT NOT NULL,
            applied_generation BIGINT,
            actual_channel TEXT,
            actual_config_digest TEXT,
            observed_instance_id TEXT,
            observed_at TEXT,
            retry_count INTEGER DEFAULT '0' NOT NULL,
            next_retry_at TEXT,
            last_error_code TEXT,
            last_error_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (connector_id, runtime_id),
            FOREIGN KEY(connector_id, runtime_id) REFERENCES device_runtimes (connector_id, runtime_id) ON DELETE CASCADE,
            CHECK (applied_generation IS NULL OR applied_generation <= desired_generation),
            FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        "CREATE INDEX idx_channel_sync_due ON runtime_channel_sync (connector_id, runtime_id) WHERE applied_generation IS DISTINCT FROM desired_generation"
    )
    op.execute(
        "CREATE INDEX idx_channel_sync_retry ON runtime_channel_sync (next_retry_at)"
    )
    op.execute("CREATE INDEX idx_channel_sync_user ON runtime_channel_sync (user_id)")
    op.execute(
        """
        CREATE TABLE channel_sync_outbox (
            id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            next_attempt_at TEXT NOT NULL,
            attempts INTEGER DEFAULT '0' NOT NULL,
            claim_owner TEXT,
            claim_until TEXT,
            delivered_at TEXT,
            PRIMARY KEY (id),
            FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
            FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        "CREATE INDEX idx_channel_outbox_pending ON channel_sync_outbox (next_attempt_at) WHERE delivered_at IS NULL"
    )
    op.execute(
        """
        CREATE TABLE channel_device_fences (
            connector_id TEXT NOT NULL,
            revision BIGINT DEFAULT '0' NOT NULL,
            PRIMARY KEY (connector_id),
            FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE TABLE channel_rotation_intents (
            user_id TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            key_id TEXT NOT NULL,
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id),
            FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE TABLE channel_device_gates (
            connector_id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (connector_id),
            FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        "INSERT INTO channel_device_fences (connector_id, revision) SELECT connector_id, MAX(switch_revision) FROM runtime_channel_switches GROUP BY connector_id"
    )


def downgrade() -> None:
    bind = op.get_bind()
    for table in (
        "runtime_channel_sync",
        "channel_sync_outbox",
        "channel_device_fences",
        "channel_rotation_intents",
        "channel_device_gates",
    ):
        if bind.execute(sa.text(f"SELECT EXISTS (SELECT 1 FROM {table})")).scalar():
            raise RuntimeError(
                "Stop channel workers and export reconciliation data before downgrading v2_52"
            )
    if bind.execute(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM runtime_channel_switches WHERE snapshot_ciphertext IS NOT NULL OR lease_owner IS NOT NULL)"
        )
    ).scalar():
        raise RuntimeError(
            "Export in-flight channel recovery snapshots before downgrading v2_52"
        )
    # Empty installations have no recovery state to lose and can be downgraded normally.
    for table in (
        "channel_device_gates",
        "channel_rotation_intents",
        "channel_device_fences",
        "channel_sync_outbox",
        "runtime_channel_sync",
    ):
        op.drop_table(table)
    for column in (
        "target_generation",
        "target_spec_digest",
        "expected_config_digest",
        "plan_ciphertext",
        "lease_owner",
        "lease_epoch",
    ):
        op.drop_column("runtime_channel_switches", column)
    op.alter_column("runtime_channel_switches", "switch_revision", type_=sa.Integer())
    op.drop_column("model_profiles", "connection_revision")
