"""v3 device link: directory fields reported by devices and durable command receipts.

Additive only; v2 content tables stay until the 3.0 cut-over migration (D8).

- ``connectors.link_contract``: ``device-meshcall/1.0`` once the device said hello over
  MeshCall; NULL for v2 Connectors.
- ``sessions``: the scheduling fields a v3 device reports (``head_seq``, ``reset_seq``,
  ``plan_state``, ``goal_state``, latest item facts, ``reported_at``), the two display
  envelopes (``display_device`` from the device, ``display_user`` from clients; JSON the
  Server stores but never reads) and ``seq_ceiling``: the highest sequence the Server
  forwarded to clients, so a device that lost its database restarts its clock above it.
  ``seq_ceiling`` starts at v2's ``max(seq, seq_allocated_high)``.
- ``device_commands``: one durable receipt per state-changing command
  (``accepted | rejected | unknown``); ``unknown`` converges through ``command.result``
  or ``Commands/status``.

Revision ID: v2_57
Revises: v2_56
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_57"
down_revision = "v2_56"
branch_labels = None
depends_on = None

_SESSION_COLUMNS = (
    ("head_seq", sa.BigInteger(), "0"),
    ("reset_seq", sa.BigInteger(), "0"),
    ("seq_ceiling", sa.BigInteger(), "0"),
    ("plan_state", sa.Text(), "none"),
    ("goal_state", sa.Text(), "none"),
)
_SESSION_NULLABLE = (
    "display_device",
    "display_user",
    "reported_at",
    "latest_item_type",
    "latest_item_role",
    "latest_item_status",
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    connector_columns = {column["name"] for column in inspector.get_columns("connectors")}
    if "link_contract" not in connector_columns:
        op.add_column("connectors", sa.Column("link_contract", sa.Text()))

    session_columns = {column["name"] for column in inspector.get_columns("sessions")}
    for name, type_, default in _SESSION_COLUMNS:
        if name not in session_columns:
            op.add_column(
                "sessions",
                sa.Column(name, type_, nullable=False, server_default=default),
            )
    for name in _SESSION_NULLABLE:
        if name not in session_columns:
            op.add_column("sessions", sa.Column(name, sa.Text()))
    if "seq_ceiling" not in session_columns:
        op.execute("UPDATE sessions SET seq_ceiling = GREATEST(seq, seq_allocated_high)")

    if "device_commands" not in inspector.get_table_names():
        op.create_table(
            "device_commands",
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("command_id", sa.Text(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column("input_digest", sa.Text()),
            sa.Column(
                "device_id",
                sa.Text(),
                sa.ForeignKey("connectors.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("session_id", sa.Text()),
            sa.Column("state", sa.Text(), nullable=False),
            sa.Column("payload_json", sa.Text()),
            sa.Column("result_json", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("user_id", "command_id"),
            sa.CheckConstraint(
                "state IN ('pending','accepted','rejected','unknown')",
                name="ck_device_commands_state",
            ),
        )
        op.create_index(
            "idx_device_commands_device_state",
            "device_commands",
            ["device_id", "state"],
        )


def downgrade() -> None:
    op.drop_index("idx_device_commands_device_state", table_name="device_commands")
    op.drop_table("device_commands")
    for name in _SESSION_NULLABLE:
        op.drop_column("sessions", name)
    for name, _type, _default in _SESSION_COLUMNS:
        op.drop_column("sessions", name)
    op.drop_column("connectors", "link_contract")
