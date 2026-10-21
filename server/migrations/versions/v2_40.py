"""Remove inactivity auto-archive from sessions.

v2_38 added a sweeper that archived sessions idle for 30 days. The product does
not want sessions to disappear on their own, so the feature is gone. Sessions
the sweeper archived are returned to the sidebar before the columns are
dropped; a user's own archive is left as it is.

Revision ID: v2_40
Revises: v2_39
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_40"
down_revision = "v2_39"
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
    if "auto_archived" in columns:
        op.execute(
            "UPDATE sessions SET archived = 0, archived_at = NULL "
            "WHERE auto_archived = 1"
        )
    if AUTO_ARCHIVE_INDEX in _index_names():
        op.drop_index(AUTO_ARCHIVE_INDEX, table_name="sessions")
    if "auto_archived_at" in columns:
        op.drop_column("sessions", "auto_archived_at")
    if "auto_archived" in columns:
        op.drop_column("sessions", "auto_archived")


def downgrade() -> None:
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
