"""Widen session sequence clocks and persist the allocation high watermark.

Revision ID: v2_23
Revises: v2_22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_23"
down_revision: str | None = "v2_22"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SESSION_SEQUENCE_COLUMNS = (
    "last_read_seq",
    "latest_turn_end_seq",
    "timeline_reset_seq",
    "seq",
    "updated_seq",
)
_INT32_MIN = -(2**31)
_INT32_MAX = 2**31 - 1
_PROTOCOL_MAX_REVISION = 2**53 - 1


def upgrade() -> None:
    bind = op.get_bind()
    session_columns = {
        column["name"] for column in sa.inspect(bind).get_columns("sessions")
    }
    if "seq_allocated_high" not in session_columns:
        op.add_column(
            "sessions",
            sa.Column(
                "seq_allocated_high",
                sa.BigInteger(),
                nullable=False,
                server_default="0",
            ),
        )

    _backfill_sequence_watermarks()
    _alter_sequence_types(sa.BigInteger())


def downgrade() -> None:
    bind = op.get_bind()
    allocated_ahead = bind.execute(
        sa.text("SELECT 1 FROM sessions WHERE seq_allocated_high <> seq LIMIT 1")
    ).first()
    if allocated_ahead is not None:
        raise RuntimeError(
            "cannot downgrade v2.23 while allocated sequence ranges are ahead of "
            "the durable session sequence"
        )

    for table_name, column_name in (
        *(("sessions", column_name) for column_name in _SESSION_SEQUENCE_COLUMNS),
        ("timeline_items", "updated_seq"),
    ):
        out_of_range = bind.execute(
            sa.text(
                f"SELECT 1 FROM {table_name} "
                f"WHERE {column_name} < :minimum OR {column_name} > :maximum LIMIT 1"
            ),
            {"minimum": _INT32_MIN, "maximum": _INT32_MAX},
        ).first()
        if out_of_range is not None:
            raise RuntimeError(
                f"cannot downgrade v2.23 because {table_name}.{column_name} "
                "contains a value outside the signed 32-bit range"
            )

    op.drop_column("sessions", "seq_allocated_high")
    _alter_sequence_types(sa.Integer())


def _alter_sequence_types(target_type: sa.types.TypeEngine) -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        # SQLite INTEGER storage is already a signed 64-bit value. Rebuilding
        # these tables solely to change the declared type would add risk and no
        # storage capability.
        return

    source_type = (
        sa.Integer() if isinstance(target_type, sa.BigInteger) else sa.BigInteger()
    )
    for column_name in _SESSION_SEQUENCE_COLUMNS:
        op.alter_column(
            "sessions",
            column_name,
            existing_type=source_type,
            type_=target_type,
            existing_nullable=False,
        )
    op.alter_column(
        "timeline_items",
        "updated_seq",
        existing_type=source_type,
        type_=target_type,
        existing_nullable=False,
    )


def _backfill_sequence_watermarks() -> None:
    bind = op.get_bind()
    greatest = "MAX" if bind.dialect.name == "sqlite" else "GREATEST"
    high_expression = (
        f"{greatest}(seq, updated_seq, last_read_seq, latest_turn_end_seq, "
        "timeline_reset_seq, COALESCE((SELECT MAX(t.updated_seq) "
        "FROM timeline_items AS t WHERE t.session_id = sessions.id), 0))"
    )
    invalid = bind.execute(
        sa.text(
            f"SELECT 1 FROM sessions WHERE ({high_expression}) < 0 "
            f"OR ({high_expression}) > :maximum LIMIT 1"
        ),
        {"maximum": _PROTOCOL_MAX_REVISION},
    ).first()
    if invalid is not None:
        raise RuntimeError(
            "cannot upgrade to v2.23 because a session sequence is outside "
            "the protocol range"
        )
    op.execute(
        sa.text(
            f"UPDATE sessions SET seq = ({high_expression}), "
            f"updated_seq = ({high_expression}), "
            f"seq_allocated_high = ({high_expression})"
        )
    )
