"""Remove unconfigured runtime placeholders left by manual deletion.

Manual deletion used to keep an unconfigured successor row with a fresh ID.
Deletion now removes the instance, so those placeholders are dropped and stop
holding a configured-instance slot or the instance name. Rows that still have
sessions bound to them are kept.

Revision ID: v2_42
Revises: v2_41
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_42"
down_revision = "v2_41"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(sa.text(
        "DELETE FROM device_runtimes "
        "WHERE config_json IS NULL "
        "AND NOT EXISTS ("
        "  SELECT 1 FROM sessions"
        "  WHERE sessions.connector_id = device_runtimes.connector_id"
        "  AND sessions.runtime_id = device_runtimes.runtime_id"
        ")"
    ))


def downgrade() -> None:
    # Deleted placeholders carried no configuration or sessions.
    pass
