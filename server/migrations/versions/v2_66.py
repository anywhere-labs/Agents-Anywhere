"""Drop ``channel_device_gates``.

The table held a per-device gate (connection id and expiry) for channel reconciliation notices. Nothing reads or
writes it any more, so it is dropped. Downgrade recreates the empty table with the layout ``v2_52`` created.

Revision ID: v2_66
Revises: v2_65
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_66"
down_revision = "v2_65"
branch_labels = None
depends_on = None

_GATES = "channel_device_gates"


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if _GATES in _tables():
        op.drop_table(_GATES)


def downgrade() -> None:
    if _GATES in _tables():
        return
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
