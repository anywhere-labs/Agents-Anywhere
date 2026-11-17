"""One receipt table for every command: ``device_commands.origin`` (docs/v3/14-unified-client-path.md §C).

``device_commands`` held the receipts of commands the Server sends; ``e2ee_command_registrations`` held the
plaintext registrations of commands that travel inside an E2EE secure channel. Both keep the same facts (ids, an
input digest, the outcome and its error code), so they become one table with an ``origin`` column:

* ``server``: a command the Server sends (``Commands/*``), the existing rows;
* ``client``: a client API command the Server forwards with ``Client/call``;
* ``sealed``: a command registered before it travels inside a secure channel.

Registrations are copied over with ``kind = 'sealed'`` and kept for the same seven days. A sealed command id is
unique across users (a partial unique index), as the registration table's primary key was. No content is stored.

Revision ID: v2_65
Revises: v2_64
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_65"
down_revision = "v2_64"
branch_labels = None
depends_on = None

_ORIGIN_CHECK = "ck_device_commands_origin"
_SEALED_INDEX = "uq_device_commands_sealed_command"
_REGISTRATIONS = "e2ee_command_registrations"
_REGISTRATION_INDEX = "idx_e2ee_command_registrations_device_created"
# ``YYYY-MM-DDTHH:MM:SS.ffffff+00:00``, the format ``device_commands`` writes.
_ISO = "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'"


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("device_commands")}
    if "origin" not in columns:
        op.add_column("device_commands", sa.Column("origin", sa.Text(), nullable=False, server_default="server"))
        op.create_check_constraint(_ORIGIN_CHECK, "device_commands", "origin IN ('server','client','sealed')")
        op.create_index(
            _SEALED_INDEX,
            "device_commands",
            ["command_id"],
            unique=True,
            postgresql_where=sa.text("origin = 'sealed'"),
        )
    if _REGISTRATIONS not in tables:
        return
    op.get_bind().execute(
        sa.text(
            f"""
            INSERT INTO device_commands (
                user_id, command_id, kind, input_digest, device_id, session_id, state, payload_json, result_json,
                created_at, updated_at, expires_at, origin
            )
            SELECT
                r.user_id, r.command_id, 'sealed', r.input_digest, r.device_id, NULL,
                COALESCE(r.outcome, 'pending'), NULL,
                CASE WHEN r.error_code IS NOT NULL
                     THEN jsonb_build_object('e', jsonb_build_object('code', r.error_code, 'retryable', false))::text
                END,
                r.created_at, COALESCE(r.finished_at, r.created_at),
                to_char((r.created_at::timestamptz + interval '7 days') AT TIME ZONE 'UTC', {_ISO}),
                'sealed'
            FROM {_REGISTRATIONS} AS r
            ON CONFLICT DO NOTHING
            """
        )
    )
    op.drop_index(_REGISTRATION_INDEX, table_name=_REGISTRATIONS)
    op.drop_table(_REGISTRATIONS)


def downgrade() -> None:
    if _REGISTRATIONS not in _tables():
        op.create_table(
            _REGISTRATIONS,
            sa.Column("command_id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("device_id", sa.Text(), sa.ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
            sa.Column("input_digest", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("outcome", sa.Text()),
            sa.Column("error_code", sa.Text()),
            sa.Column("finished_at", sa.Text()),
        )
        op.create_index(_REGISTRATION_INDEX, _REGISTRATIONS, ["device_id", "created_at"])
    op.get_bind().execute(
        sa.text(
            f"""
            INSERT INTO {_REGISTRATIONS} (
                command_id, user_id, device_id, input_digest, created_at, outcome, error_code, finished_at
            )
            SELECT
                d.command_id, d.user_id, d.device_id, COALESCE(d.input_digest, ''), d.created_at,
                CASE WHEN d.state IN ('accepted', 'rejected') THEN d.state END,
                CASE WHEN d.state = 'rejected' THEN d.result_json::jsonb -> 'e' ->> 'code' END,
                CASE WHEN d.state IN ('accepted', 'rejected') THEN d.updated_at END
            FROM device_commands AS d
            WHERE d.origin = 'sealed' AND d.user_id IN (SELECT id FROM users)
            ON CONFLICT DO NOTHING
            """
        )
    )
    # Receipts of forwarded client commands have no place in the older layout; a retry starts a fresh one.
    op.get_bind().execute(sa.text("DELETE FROM device_commands WHERE origin IN ('sealed', 'client')"))
    op.drop_index(_SEALED_INDEX, table_name="device_commands")
    op.drop_constraint(_ORIGIN_CHECK, "device_commands", type_="check")
    op.drop_column("device_commands", "origin")
