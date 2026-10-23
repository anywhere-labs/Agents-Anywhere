"""Native project identity and workspace synchronization operations."""

import sqlalchemy as sa
from alembic import op

revision = "v2_45"
down_revision = "v2_44"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _ensure_workspace_inventory()
    inspector = sa.inspect(op.get_bind())
    for table, columns in {
        "connectors": [sa.Column("workspace_epoch", sa.Text())],
        "projects": [
            sa.Column("runtime", sa.Text()),
            sa.Column("runtime_id", sa.Text()),
            sa.Column("native_project_id", sa.Text()),
            sa.Column(
                "identity_kind", sa.Text(), nullable=False, server_default="legacy"
            ),
            sa.Column("roots_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column(
                "source_state", sa.Text(), nullable=False, server_default="pending"
            ),
        ],
        "sessions": [
            sa.Column("native_project_id", sa.Text()),
            sa.Column("project_sync_reason", sa.Text()),
        ],
    }.items():
        existing = {c["name"] for c in inspector.get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)
    constraints = {c["name"] for c in inspector.get_unique_constraints("projects")}
    for name in ("uq_projects_user_connector_workspace", "uq_projects_user_name"):
        if name in constraints:
            op.drop_constraint(name, "projects", type_="unique")
    if "uq_projects_native_identity" not in constraints:
        op.create_unique_constraint(
            "uq_projects_native_identity",
            "projects",
            ["connector_id", "runtime_id", "native_project_id"],
        )
    if not inspector.has_table("project_operations"):
        op.create_table(
            "project_operations",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "connector_id",
                sa.Text(),
                sa.ForeignKey("connectors.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("runtime", sa.Text(), nullable=False),
            sa.Column("runtime_id", sa.Text(), nullable=False),
            sa.Column("request_id", sa.Text(), nullable=False),
            sa.Column("request_json", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("result_json", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.UniqueConstraint(
                "user_id", "request_id", name="uq_project_operation_request"
            ),
        )


def _ensure_workspace_inventory() -> None:
    # Unversioned databases adopted through metadata.create_all may already
    # contain this table while older columns elsewhere still need migration.
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("runtime_workspace_inventories"):
        columns = {
            column["name"]
            for column in inspector.get_columns("runtime_workspace_inventories")
        }
        primary_key = set(
            inspector.get_pk_constraint("runtime_workspace_inventories")[
                "constrained_columns"
            ]
        )
        if columns != {
            "connector_id",
            "runtime_id",
            "snapshot_id",
            "observed_at",
            "snapshot_json",
        } or primary_key != {"connector_id", "runtime_id"}:
            raise RuntimeError(
                "existing runtime workspace inventory table has an incompatible schema"
            )
        return
    op.create_table(
        "runtime_workspace_inventories",
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("runtime_id", sa.Text(), primary_key=True),
        sa.Column("snapshot_id", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.Text(), nullable=False),
        sa.Column("snapshot_json", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    raise RuntimeError(
        "Native projects may share names and paths. Restore a matching application/database backup to downgrade."
    )
