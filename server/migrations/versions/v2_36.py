"""Keep manually deleted runtime identities retired across Connector reconnects."""

import sqlalchemy as sa
from alembic import op

revision = "v2_36"
down_revision = "v2_35"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Unversioned imports create current metadata before being stamped.
    if sa.inspect(op.get_bind()).has_table("retired_device_runtimes"):
        return
    op.create_table(
        "retired_device_runtimes",
        sa.Column("connector_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("retired_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id"),
    )


def downgrade() -> None:
    op.drop_table("retired_device_runtimes")
