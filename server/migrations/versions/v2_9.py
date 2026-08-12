"""Remove runtime turn data from Server timelines.

Revision ID: v2_9
Revises: v2_8
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "v2_9"
down_revision: str | None = "v2_8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    _rename_dashboard_usage(bind, from_name="turns", to_name="messages")
    timeline_items = sa.table(
        "timeline_items",
        sa.column("session_id", sa.Text()),
        sa.column("id", sa.Text()),
        sa.column("type", sa.Text()),
        sa.column("payload_json", sa.Text()),
    )
    bind.execute(
        timeline_items.delete().where(
            timeline_items.c.type.in_(("turn.start", "turn.end"))
        )
    )
    rows = bind.execute(
        sa.select(
            timeline_items.c.session_id,
            timeline_items.c.id,
            timeline_items.c.payload_json,
        )
    ).mappings().all()
    for row in rows:
        payload = json.loads(row["payload_json"])
        cleaned = _without_turn_data(payload)
        if cleaned == payload:
            continue
        bind.execute(
            timeline_items.update()
            .where(
                timeline_items.c.session_id == row["session_id"],
                timeline_items.c.id == row["id"],
            )
            .values(
                payload_json=json.dumps(
                    cleaned,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        )

    columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("timeline_items")
    }
    if "turn_id" in columns:
        op.drop_column("timeline_items", "turn_id")


def downgrade() -> None:
    bind = op.get_bind()
    _rename_dashboard_usage(bind, from_name="messages", to_name="turns")
    columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("timeline_items")
    }
    if "turn_id" not in columns:
        op.add_column(
            "timeline_items",
            sa.Column("turn_id", sa.Text(), nullable=True),
        )


def _without_turn_data(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            key: _without_turn_data(item)
            for key, item in value.items()
            if key not in {"turnId", "turn_id"}
        }
    if isinstance(value, list):
        return [_without_turn_data(item) for item in value]
    return value


def _rename_dashboard_usage(bind: Any, *, from_name: str, to_name: str) -> None:
    fact_columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("dashboard_user_daily_facts")
    }
    if from_name in fact_columns and to_name not in fact_columns:
        op.alter_column(
            "dashboard_user_daily_facts",
            from_name,
            new_column_name=to_name,
            existing_type=sa.Integer(),
            existing_nullable=False,
        )

    metric_names = {
        "usage.turns": "usage.messages",
        "usage.avg_turns_per_active_user": "usage.avg_messages_per_active_user",
        "usage.turn_histogram": "usage.message_histogram",
    }
    if from_name == "messages":
        metric_names = {value: key for key, value in metric_names.items()}
    metrics = sa.table(
        "dashboard_daily_metrics",
        sa.column("metric_key", sa.Text()),
    )
    for old_key, new_key in metric_names.items():
        bind.execute(
            metrics.update()
            .where(metrics.c.metric_key == old_key)
            .values(metric_key=new_key)
        )

    settings = sa.table(
        "dashboard_settings",
        sa.column("key", sa.Text()),
        sa.column("value_json", sa.Text()),
    )
    row = bind.execute(
        sa.select(settings.c.value_json).where(settings.c.key == "settings")
    ).mappings().first()
    if row is None:
        return
    value = json.loads(row["value_json"])
    intensity = value.get("intensity")
    if isinstance(intensity, dict) and intensity.get("basis") == from_name:
        intensity["basis"] = to_name
    histogram_bins = value.get("histogramBins")
    if isinstance(histogram_bins, dict) and from_name in histogram_bins:
        histogram_bins[to_name] = histogram_bins.pop(from_name)
    bind.execute(
        settings.update()
        .where(settings.c.key == "settings")
        .values(
            value_json=json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    )
