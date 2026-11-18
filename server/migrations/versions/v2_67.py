"""Agent collaboration: delegations, supervision edges, session origin, receipt actor, account settings.

* ``agent_delegations``: the delegation tokens a device was issued for its Agent (only a hash of the token), with
  the grant they belong to, the supervisor session and the devices they reach; revoked with the grant.
* ``collab_edges``: the supervision edges devices report (``collab.supervision.changed``), ids and state only.
* ``sessions.origin_*``: who created a session when an Agent did (immutable once set).
* ``device_commands.actor``: ``user`` or ``agent:<deviceId>/<sessionId>``, who sent a forwarded command.
* ``users.agent_collaboration``: the account's collaboration settings (JSON), handed to every device.

No content is stored.

Revision ID: v2_67
Revises: v2_66
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_67"
down_revision = "v2_66"
branch_labels = None
depends_on = None

_DELEGATIONS = "agent_delegations"
_EDGES = "collab_edges"
_ORIGIN_COLUMNS = ("origin_kind", "origin_session_id", "origin_device_id", "origin_depth")


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    tables = _tables()
    if _DELEGATIONS not in tables:
        op.create_table(
            _DELEGATIONS,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("device_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
            sa.Column("supervisor_session_id", sa.Text(), nullable=False),
            sa.Column("grant_id", sa.Text(), nullable=False),
            sa.Column("scope_json", sa.Text(), nullable=False),
            sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
            sa.Column("expires_at", sa.Text(), nullable=False),
            sa.Column("revoked_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_agent_delegations_grant", _DELEGATIONS, ["device_id", "grant_id"])
        op.create_index("idx_agent_delegations_supervisor", _DELEGATIONS, ["supervisor_session_id"])
    if _EDGES not in tables:
        op.create_table(
            _EDGES,
            sa.Column("supervision_id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("supervisor_session_id", sa.Text(), nullable=False),
            sa.Column("supervisor_device_id", sa.Text(), nullable=False),
            sa.Column("target_session_id", sa.Text(), nullable=False),
            sa.Column("target_device_id", sa.Text(), nullable=False),
            sa.Column("state", sa.Text(), nullable=False),
            sa.Column("created_by", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.CheckConstraint("state IN ('active','paused','ended')", name="ck_collab_edges_state"),
            sa.CheckConstraint("created_by IN ('human','agent')", name="ck_collab_edges_created_by"),
        )
        op.create_index("idx_collab_edges_target", _EDGES, ["target_session_id", "state"])
        op.create_index("idx_collab_edges_supervisor", _EDGES, ["supervisor_session_id", "state"])
        op.create_index("idx_collab_edges_user", _EDGES, ["user_id", "state"])
    session_columns = _columns("sessions")
    for name in _ORIGIN_COLUMNS:
        if name not in session_columns:
            op.add_column("sessions", sa.Column(name, sa.Integer() if name == "origin_depth" else sa.Text()))
    if "actor" not in _columns("device_commands"):
        op.add_column("device_commands", sa.Column("actor", sa.Text(), nullable=False, server_default="user"))
    if "agent_collaboration" not in _columns("users"):
        op.add_column("users", sa.Column("agent_collaboration", sa.Text()))


def downgrade() -> None:
    if "agent_collaboration" in _columns("users"):
        op.drop_column("users", "agent_collaboration")
    if "actor" in _columns("device_commands"):
        op.drop_column("device_commands", "actor")
    session_columns = _columns("sessions")
    for name in reversed(_ORIGIN_COLUMNS):
        if name in session_columns:
            op.drop_column("sessions", name)
    tables = _tables()
    if _EDGES in tables:
        op.drop_table(_EDGES)
    if _DELEGATIONS in tables:
        op.drop_table(_DELEGATIONS)
