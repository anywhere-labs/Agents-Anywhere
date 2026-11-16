"""3.0 cut-over: the Server stops holding session content (D8).

Session content lives on the device from 3.0 on; v3 devices re-project it from the
native history on the user's computer, so nothing here is copied or exported first.

- Drops every session content table: the timeline and its runtime event receipts,
  planning (state, plan documents, operations, creations), goals (state, history,
  operations, the event outbox), the server-owned message queue and the legacy import
  archive.
- Clears ``session_active_runs.params_json``: it could hold the text of the message
  that started the run.
- Renames ``sessions.last_read_seq`` to ``read_seq``. Its value now means the device
  clock position the user has read up to; v3 device clocks restart above v2's
  sequences, so the old marks cannot be compared. Each session gets a sentinel
  instead (``core.read_marks``): ``-1`` when it was read, ``-2`` when it was unread.
  The device's first ``latestTurnEndSeq`` resolves it.
- Marks the stored attachments for deletion (``instance_settings``
  ``v3_attachment_purge = pending``). Files live in local or S3 storage that a
  migration cannot reach, so the Server deletes them in the background after it
  starts, keeping the files a share still exposes (``AttachmentService.purge_v2_files``).

The directory columns v2 kept for its own sequence (``seq``, ``updated_seq`` and the
inventory scan fences) stay for now: v2 Connectors still report their session
lists through them and clients still read ``updatedSeq``.

Irreversible: downgrading cannot bring the content back.

Revision ID: v2_60
Revises: v2_59
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_60"
down_revision = "v2_59"
branch_labels = None
depends_on = None

CONTENT_TABLES = (
    "timeline_items",
    "session_runtime_event_receipts",
    "plan_documents",
    "planning_operations",
    "planning_creations",
    "session_planning",
    "goal_event_outbox",
    "goal_operations",
    "session_goal_state",
    "session_goals",
    "session_queued_messages",
    "session_queue_state",
    "legacy_import_archive",
)

READ_TO_LATEST = -1
UNREAD = -2


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for table in CONTENT_TABLES:
        if table in tables:
            op.execute(sa.text(f'DROP TABLE "{table}" CASCADE'))

    op.execute(sa.text("UPDATE session_active_runs SET params_json = NULL WHERE params_json IS NOT NULL"))

    op.alter_column("sessions", "last_read_seq", new_column_name="read_seq")
    op.execute(
        sa.text(
            "UPDATE sessions SET read_seq = CASE "
            "WHEN read_seq >= latest_turn_end_seq THEN :read ELSE :unread END"
        ).bindparams(read=READ_TO_LATEST, unread=UNREAD)
    )

    op.execute(
        sa.text(
            "INSERT INTO instance_settings (key, value, updated_at) "
            "VALUES ('v3_attachment_purge', 'pending', to_char(now() AT TIME ZONE 'UTC', "
            "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) "
            "ON CONFLICT (key) DO UPDATE SET value = 'pending', updated_at = EXCLUDED.updated_at"
        )
    )


def downgrade() -> None:
    raise RuntimeError(
        "v2_60 deleted session content and cannot be downgraded; restore the backup taken before the upgrade"
    )
