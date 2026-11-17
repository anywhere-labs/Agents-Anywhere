"""Command receipts keep no conversation content (D1).

``device_commands`` stored every command's payload (message text, queued items, plan input) and the
device's result body for seven days. From now on a receipt keeps the payload only for commands the
Server replays on hello (``runtime.apply``, ``device.settings.apply``, ``channel.switch``) and, of the
result, only the error code and status enums. Existing rows are cleaned the same way. No schema change.

Revision ID: v2_64
Revises: v2_63
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_64"
down_revision = "v2_63"
branch_labels = None
depends_on = None

_DEFERRABLE = ("runtime.apply", "device.settings.apply", "channel.switch")


def upgrade() -> None:
    bind = op.get_bind()
    if "device_commands" not in set(sa.inspect(bind).get_table_names()):
        return
    bind.execute(
        sa.text(
            "UPDATE device_commands SET payload_json = NULL "
            "WHERE payload_json IS NOT NULL AND kind NOT IN :deferrable"
        ).bindparams(sa.bindparam("deferrable", expanding=True)),
        {"deferrable": list(_DEFERRABLE)},
    )
    # Keep ``e.code`` / ``e.retryable`` and ``r.execution``; drop everything else of the result.
    bind.execute(
        sa.text(
            """
            UPDATE device_commands AS d SET result_json = kept.value
            FROM (
                SELECT user_id, command_id, NULLIF(jsonb_strip_nulls(jsonb_build_object(
                    'r', CASE WHEN jsonb_typeof(doc -> 'r' -> 'execution') = 'string'
                              THEN jsonb_build_object('execution', doc -> 'r' -> 'execution') END,
                    'e', CASE WHEN jsonb_typeof(doc -> 'e') = 'object'
                              THEN jsonb_build_object(
                                  'code', COALESCE(doc -> 'e' ->> 'code', 'error'),
                                  'retryable', COALESCE((doc -> 'e' ->> 'retryable')::boolean, false)
                              ) END
                )), '{}'::jsonb)::text AS value
                FROM (
                    SELECT user_id, command_id, result_json::jsonb AS doc
                    FROM device_commands WHERE result_json IS NOT NULL
                ) AS parsed
            ) AS kept
            WHERE d.user_id = kept.user_id AND d.command_id = kept.command_id
            """
        )
    )


def downgrade() -> None:
    # The removed content is gone; the older code reads receipts without it.
    pass
