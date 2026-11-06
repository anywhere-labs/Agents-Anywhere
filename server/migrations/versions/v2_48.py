"""Track session inventory scans without rewriting every session row.

Every complete inventory scan used to stamp ``source_scan_token`` on all sessions
of the runtime and clear it again, so an unchanged scan rewrote each row twice.
A scan now lives in one ``session_inventory_scans`` row. The per-row question "did
this source state move after the scan started?" is answered by comparing
``sessions.source_changed_seq`` with the sequence value the scan took when it began.

``source_changed_seq`` is added without a default first and gets its default in a
second statement: existing rows stay ``NULL`` (older than any scan), and the default
applies only to future inserts, so neither statement rewrites the large table.

``source_scan_token`` is kept so the previous Server release can still run against
this schema during a rollback. Nothing in this release reads or writes it.

Revision ID: v2_48
Revises: v2_47
"""

from alembic import op

revision = "v2_48"
down_revision = "v2_47"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE session_source_change_seq")
    op.execute("ALTER TABLE sessions ADD COLUMN source_changed_seq BIGINT")
    op.execute(
        "ALTER TABLE sessions ALTER COLUMN source_changed_seq "
        "SET DEFAULT nextval('session_source_change_seq')"
    )
    op.execute(
        "ALTER SEQUENCE session_source_change_seq OWNED BY sessions.source_changed_seq"
    )
    op.execute(
        """
CREATE TABLE session_inventory_scans (
 connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
 runtime TEXT NOT NULL,
 runtime_id TEXT NOT NULL,
 scan_token TEXT NOT NULL,
 started_seq BIGINT NOT NULL,
 started_at TEXT NOT NULL,
 PRIMARY KEY (connector_id, runtime, runtime_id)
)
"""
    )


def downgrade() -> None:
    op.execute("DROP TABLE session_inventory_scans")
    # Dropping the owning column also drops the sequence.
    op.execute("ALTER TABLE sessions DROP COLUMN source_changed_seq")
