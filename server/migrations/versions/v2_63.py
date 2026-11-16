"""Command registrations for the E2EE required mode.

In required mode a client sends commands through the end-to-end encrypted channel; it first registers
``{commandId, deviceId, inputDigest}`` in plaintext so the Server keeps per-command idempotency and the final
outcome. ``inputDigest`` is an HMAC keyed by the device's directory key, so the Server can compare two
registrations but not confirm a guessed input. No content is stored. The table is new; no rows are rewritten.

Revision ID: v2_63
Revises: v2_62
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_63"
down_revision = "v2_62"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "e2ee_command_registrations" in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        "e2ee_command_registrations",
        sa.Column("command_id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
        sa.Column("input_digest", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text()),
        sa.Column("error_code", sa.Text()),
        sa.Column("finished_at", sa.Text()),
    )
    op.create_index(
        "idx_e2ee_command_registrations_device_created",
        "e2ee_command_registrations",
        ["device_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_e2ee_command_registrations_device_created", table_name="e2ee_command_registrations")
    op.drop_table("e2ee_command_registrations")
