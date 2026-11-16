"""Terminal roots move to Redis (``05-server.md`` §3.1).

``connector_terminal_roots`` only remembered which workspace root and cwd the Server
opened each Connector terminal with. The PTY lives on the device, so this is runtime
state: it now lives in Redis (or in the process without Redis) and is cleared with
the device or its sessions. Roots of terminals open during the upgrade are not
carried over: such a terminal keeps running on the device and its list entry shows
the cwd the device reports, but if the Server has to set up its relay again it
answers "terminal not found" and the user opens a new terminal.

Downgrading recreates the empty table.

Revision ID: v2_62
Revises: v2_61
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_62"
down_revision = "v2_61"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("connector_terminal_roots")


def downgrade() -> None:
    op.create_table(
        "connector_terminal_roots",
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("terminal_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("root", sa.Text(), nullable=False),
        sa.Column("cwd", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "terminal_id"),
    )
    op.create_index(
        "idx_connector_terminal_roots_session",
        "connector_terminal_roots",
        ["connector_id", "session_id"],
    )
