"""Add the runtime instance startup phase.

A runtime instance that is ``starting`` can now report which step it is in
(for example DSH synchronizing its sessions). The phase is informational and
stored next to the error payload so clients stop rendering a sync as a fault.

Revision ID: v2_43
Revises: v2_42
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_43"
down_revision = "v2_42"
branch_labels = None
depends_on = None

TABLE = "device_runtimes"
COLUMN = "phase_json"


def _column_names() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if TABLE not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(TABLE)}


def upgrade() -> None:
    if COLUMN not in _column_names():
        op.add_column(TABLE, sa.Column(COLUMN, sa.Text(), nullable=True))


def downgrade() -> None:
    if COLUMN in _column_names():
        op.drop_column(TABLE, COLUMN)
