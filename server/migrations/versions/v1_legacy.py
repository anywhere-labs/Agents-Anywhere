"""Recognize the last unversioned v1 database layout.

Revision ID: v1_legacy
Revises:
"""

from collections.abc import Sequence

revision: str = "v1_legacy"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Empty databases are built by v2_0. Existing v1 databases are fingerprinted
    # and stamped at this revision before the forward migration runs.
    pass


def downgrade() -> None:
    pass
