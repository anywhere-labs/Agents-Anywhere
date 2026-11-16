"""Port previews (``contracts/preview/1.0``).

One row per device port: the slug (the preview's DNS label under the separate preview
domain) is reused when the same port is previewed again. Holds no page content.

Revision ID: v2_61
Revises: v2_60
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_61"
down_revision = "v2_60"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "previews",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.Text(), sa.ForeignKey("sessions.id", ondelete="SET NULL")),
        sa.Column("port", sa.Integer(), nullable=False),
        sa.Column("visibility", sa.Text(), nullable=False, server_default="private"),
        sa.Column("state", sa.Text(), nullable=False, server_default="opening"),
        sa.Column("close_reason", sa.Text()),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("device_id", "port", name="uq_previews_device_port"),
    )
    op.create_index("idx_previews_user", "previews", ["user_id"])
    op.create_index("idx_previews_state_expires", "previews", ["state", "expires_at"])


def downgrade() -> None:
    op.drop_index("idx_previews_state_expires", table_name="previews")
    op.drop_index("idx_previews_user", table_name="previews")
    op.drop_table("previews")
