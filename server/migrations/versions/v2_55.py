"""Keep user-chosen device settings on each connector.

Device settings are behaviour switches a user picks for one device from any
client, such as whether Desktop asks before quitting when the computer shuts
down. The server owns them and hands them to the connector whenever it
connects, so a change made while the device is offline still takes effect.

They live in their own column because ``user_preferences`` is written by the
connector and replaced on every report. Adding a nullable column rewrites no
rows; ``NULL`` means every setting keeps its default.

Revision ID: v2_55
Revises: v2_54
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_55"
down_revision = "v2_54"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("connectors")
    }
    if "device_settings" not in existing:
        op.add_column("connectors", sa.Column("device_settings", sa.Text()))


def downgrade() -> None:
    op.drop_column("connectors", "device_settings")
