"""Add inactivity auto-archive state to sessions.

The sidebar grows without bound because nothing ever archives an idle session.
A periodic sweeper now archives sessions with no activity for 30 days, but that
state must stay distinguishable from a user's own archive action:

* A user archive is an explicit intent and must never be undone automatically.
* An auto archive is only a fold-away and must reopen when activity returns.

``auto_archived`` carries the current state. ``auto_archived_at`` is a tombstone
that deliberately survives an unarchive: without it, a user who manually
unarchives a long-idle session would see the sweeper re-archive it on the very
next pass. Only genuinely new activity clears the tombstone, which makes the
session eligible again after another idle period.

Revision ID: v2_38
Revises: v2_37
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_38"
down_revision = "v2_37"
branch_labels = None
depends_on = None

AUTO_ARCHIVE_INDEX = "idx_sessions_auto_archive"


def _session_columns() -> set[str]:
    return {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }


def _index_names() -> set[str]:
    return {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("sessions")
    }


def upgrade() -> None:
    columns = _session_columns()
    if "auto_archived" not in columns:
        op.add_column(
            "sessions",
            sa.Column(
                "auto_archived", sa.Integer(), nullable=False, server_default="0"
            ),
        )
    if "auto_archived_at" not in columns:
        op.add_column("sessions", sa.Column("auto_archived_at", sa.Text(), nullable=True))
    if AUTO_ARCHIVE_INDEX not in _index_names():
        op.create_index(
            AUTO_ARCHIVE_INDEX,
            "sessions",
            ["archived", "auto_archived", "pinned", "sort_at"],
            unique=False,
        )


def downgrade() -> None:
    if AUTO_ARCHIVE_INDEX in _index_names():
        op.drop_index(AUTO_ARCHIVE_INDEX, table_name="sessions")
    columns = _session_columns()
    if "auto_archived_at" in columns:
        op.drop_column("sessions", "auto_archived_at")
    if "auto_archived" in columns:
        op.drop_column("sessions", "auto_archived")
