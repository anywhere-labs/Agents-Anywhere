"""Persistent MeshCall operation dispatch; preserve legacy unknown receipts."""

import sqlalchemy as sa
from alembic import op

revision = "v2_46"
down_revision = "v2_45"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("project_operations")
    }
    for column in (
        sa.Column("execution_json", sa.Text()),
        sa.Column(
            "execution_status", sa.Text(), nullable=False, server_default="reconciling"
        ),
        sa.Column(
            "dispatch_generation", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("lease_until", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "next_dispatch_at", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.Column(
            "delivery_accepted", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("result_received", sa.Integer(), nullable=False, server_default="0"),
    ):
        if column.name not in existing:
            op.add_column("project_operations", column)
    op.execute(
        "UPDATE project_operations SET execution_status = status WHERE status IN ('succeeded', 'failed')"
    )
    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("project_operations")
    }
    if "idx_project_operations_dispatch" not in indexes:
        op.create_index(
            "idx_project_operations_dispatch",
            "project_operations",
            ["status", "next_dispatch_at", "lease_until"],
        )


def downgrade() -> None:
    raise RuntimeError(
        "Retain operation receipts; downgrade requires reconciling outstanding operations first"
    )
