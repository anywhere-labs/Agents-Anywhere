"""Bind encrypted mobile login exchange to the scanner."""
from alembic import op
import sqlalchemy as sa

revision = "v2_67"
down_revision = "v2_66"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mobile_login_tokens", sa.Column("scan_challenge", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("mobile_login_tokens", "scan_challenge")
