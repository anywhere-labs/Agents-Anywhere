"""Model connection reports, model configuration and Tokens Anywhere links.

Revision ID: v2_47
Revises: v2_46
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_47"
down_revision = "v2_46"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # What the runtime adapter last reported about the saved model connection,
    # with a digest of the connection it was started with.
    op.add_column("device_runtimes", sa.Column("model_connection_json", sa.Text()))
    op.create_table(
        "tokens_links",
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("issuer", sa.Text(), nullable=False),
        sa.Column("account_json", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("refresh_token_ciphertext", sa.Text()),
        sa.Column("linked_at", sa.Text(), nullable=False),
        sa.Column("refreshed_at", sa.Text()),
        sa.Column("issued_at", sa.Text(), nullable=False),
    )
    op.create_table(
        "tokens_link_states",
        sa.Column("state_hash", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ticket_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("browser_hash", sa.Text()),
        sa.Column("code_verifier_ciphertext", sa.Text(), nullable=False),
        sa.Column("issuer", sa.Text(), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("consumed_at", sa.Text()),
    )
    op.create_table(
        "model_profiles",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("origin_host", sa.Text(), nullable=False),
        sa.Column("offers_json", sa.Text(), nullable=False),
        sa.Column("catalog_digest", sa.Text(), nullable=False),
        sa.Column("key_ref_json", sa.Text(), nullable=False),
        sa.Column("secret_ciphertext", sa.Text()),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("etag", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
    op.create_index("idx_model_profiles_user_id", "model_profiles", ["user_id"])
    op.create_table(
        "runtime_model_assignments",
        sa.Column("connector_id", sa.Text(), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column(
            "profile_id",
            sa.Text(),
            sa.ForeignKey("model_profiles.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("offer_format", sa.Text(), nullable=False),
        sa.Column("created_runtime", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("applied_digest", sa.Text(), nullable=False),
        sa.Column("applied_catalog_digest", sa.Text(), nullable=False),
        sa.Column("imported_model_ids_json", sa.Text(), nullable=False),
        sa.Column("previous_gateway_ciphertext", sa.Text()),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("error_json", sa.Text()),
        sa.Column("applied_at", sa.Text()),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id"),
        sa.ForeignKeyConstraint(
            ["connector_id", "runtime_id"],
            ["device_runtimes.connector_id", "device_runtimes.runtime_id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "idx_runtime_model_assignments_profile_id",
        "runtime_model_assignments",
        ["profile_id"],
    )
    op.create_table(
        "model_config_operations",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_digest", sa.Text(), nullable=False),
        sa.Column("targets_json", sa.Text(), nullable=False),
        sa.Column("lease_until", sa.Text(), nullable=False),
        sa.Column("result_json", sa.Text()),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("finished_at", sa.Text()),
        sa.UniqueConstraint("user_id", "idempotency_key"),
    )


def downgrade() -> None:
    op.drop_table("model_config_operations")
    op.drop_index("idx_runtime_model_assignments_profile_id", "runtime_model_assignments")
    op.drop_table("runtime_model_assignments")
    op.drop_index("idx_model_profiles_user_id", "model_profiles")
    op.drop_table("model_profiles")
    op.drop_table("tokens_link_states")
    op.drop_table("tokens_links")
    op.drop_column("device_runtimes", "model_connection_json")
