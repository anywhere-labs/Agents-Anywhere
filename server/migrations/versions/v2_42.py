"""Persist resumable Connector snapshot uploads.

Revision ID: v2_42
Revises: v2_41
"""
import sqlalchemy as sa
from alembic import op

revision = "v2_42"
down_revision = "v2_41"
branch_labels = None
depends_on = None


def upgrade():
    names = set(sa.inspect(op.get_bind()).get_table_names())
    if "connector_snapshot_watermarks" not in names:
        op.create_table("connector_snapshot_watermarks",
            sa.Column("connector_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
            sa.Column("runtime_id", sa.Text(), nullable=False),
            sa.Column("session_id", sa.Text(), nullable=False),
            sa.Column("through_seq", sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint("connector_id", "runtime_id", "session_id"))
    if "connector_uploads" not in names:
        op.create_table("connector_uploads",
            sa.Column("connector_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
            sa.Column("upload_id", sa.Text(), nullable=False),
            sa.Column("session_id", sa.Text(), nullable=False),
            sa.Column("runtime_id", sa.Text(), nullable=False),
            sa.Column("through_seq", sa.BigInteger(), nullable=False),
            sa.Column("total_bytes", sa.BigInteger(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("connector_id", "upload_id"))
        op.create_index("ix_connector_uploads_scope", "connector_uploads", ["connector_id", "runtime_id", "session_id"])
        op.create_index("ix_connector_uploads_expiry", "connector_uploads", ["expires_at"])
    if "connector_upload_chunks" not in names:
        op.create_table("connector_upload_chunks",
            sa.Column("connector_id", sa.Text(), nullable=False),
            sa.Column("upload_id", sa.Text(), nullable=False),
            sa.Column("chunk_index", sa.Integer(), nullable=False),
            sa.Column("body", sa.LargeBinary(), nullable=False),
            sa.PrimaryKeyConstraint("connector_id", "upload_id", "chunk_index"),
            sa.ForeignKeyConstraint(["connector_id", "upload_id"],
                                   ["connector_uploads.connector_id", "connector_uploads.upload_id"], ondelete="CASCADE"))


def downgrade():
    op.drop_table("connector_upload_chunks")
    op.drop_table("connector_uploads")
    op.drop_table("connector_snapshot_watermarks")
