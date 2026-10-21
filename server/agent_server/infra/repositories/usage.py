from __future__ import annotations

from sqlalchemy import case, literal_column
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.usage import (
    EVENT_CONNECTOR_ONLINE,
    EVENT_MESSAGE_SENT,
    EVENT_SESSION_VIEWED,
    INVENTORY_CONNECTORS_BY_OS,
    INVENTORY_CONNECTORS_SEEN_7D,
    INVENTORY_CONNECTORS_SEEN_30D,
    INVENTORY_CONNECTORS_TOTAL,
    INVENTORY_RUNTIMES_CONFIGURED,
    INVENTORY_RUNTIMES_DISCOVERED,
    INVENTORY_USERS_ADMINS,
    INVENTORY_USERS_TOTAL,
    InventoryRow,
    InventorySnapshotRow,
    UsageConnectorRow,
    UsageCountRow,
    UsageDurationRow,
    UsageSessionRow,
    UsageUserRow,
)
from agent_server.infra.db import session_active_runs as session_active_runs_t
from agent_server.infra.repositories.store_support import *


class UsageRepositoryMixin:
    """SQL access for usage events and inventory snapshots."""

    # --- event writes -------------------------------------------------------

    async def insert_usage_events(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0
        async with self._engine.begin() as conn:
            upsert = pg_insert
            result = await conn.execute(
                upsert(usage_events_t).values(rows).on_conflict_do_nothing()
            )
            inserted = result.rowcount
        return int(inserted) if inserted is not None and inserted >= 0 else len(rows)

    async def delete_usage_events_before(self, cutoff_hour_bucket: str) -> int:
        async with self._engine.begin() as conn:
            result = await conn.execute(
                delete(usage_events_t).where(
                    usage_events_t.c.hour_bucket < cutoff_hour_bucket
                )
            )
        return int(result.rowcount or 0)

    # --- event reads --------------------------------------------------------

    async def latest_usage_event_at(
        self, *, session_id: str, event_type: str
    ) -> str | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(usage_events_t.c.occurred_at)
                    .where(
                        usage_events_t.c.session_id == session_id,
                        usage_events_t.c.event_type == event_type,
                    )
                    .order_by(usage_events_t.c.occurred_at.desc())
                    .limit(1)
                )
            ).first()
        return str(row[0]) if row is not None else None

    async def usage_first_event_date(self) -> str | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(func.min(usage_events_t.c.hour_bucket)))
            ).first()
        value = row[0] if row is not None else None
        return str(value)[:10] if value else None

    async def usage_event_counts(
        self, *, start_hour: str, end_hour: str
    ) -> list[UsageCountRow]:
        duration = func.coalesce(func.sum(usage_events_t.c.duration_ms), 0)
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.event_type,
                        usage_events_t.c.runtime_type,
                        usage_events_t.c.outcome,
                        func.count().label("count"),
                        duration.label("duration_sum"),
                    )
                    .where(_hour_range(start_hour, end_hour))
                    .group_by(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.event_type,
                        usage_events_t.c.runtime_type,
                        usage_events_t.c.outcome,
                    )
                )
            ).all()
        return [
            UsageCountRow(
                hour_bucket=str(row[0]),
                event_type=str(row[1]),
                runtime_type=row[2],
                outcome=row[3],
                count=int(row[4] or 0),
                duration_sum=int(row[5] or 0),
            )
            for row in rows
        ]

    async def usage_user_activity(
        self, *, start_hour: str, end_hour: str
    ) -> list[UsageUserRow]:
        messages = func.sum(
            case((usage_events_t.c.event_type == EVENT_MESSAGE_SENT, 1), else_=0)
        )
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.user_id,
                        messages.label("messages"),
                        func.count().label("events"),
                    )
                    .where(
                        _hour_range(start_hour, end_hour),
                        usage_events_t.c.user_id.is_not(None),
                    )
                    .group_by(usage_events_t.c.hour_bucket, usage_events_t.c.user_id)
                )
            ).all()
        return [
            UsageUserRow(
                hour_bucket=str(row[0]),
                user_id=str(row[1]),
                messages=int(row[2] or 0),
                events=int(row[3] or 0),
            )
            for row in rows
        ]

    async def usage_session_activity(
        self, *, start_hour: str, end_hour: str
    ) -> list[UsageSessionRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.event_type,
                        usage_events_t.c.session_id,
                        usage_events_t.c.runtime_type,
                        usage_events_t.c.user_id,
                        func.count().label("count"),
                    )
                    .where(
                        _hour_range(start_hour, end_hour),
                        usage_events_t.c.event_type.in_(
                            (EVENT_MESSAGE_SENT, EVENT_SESSION_VIEWED)
                        ),
                        usage_events_t.c.session_id.is_not(None),
                    )
                    .group_by(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.event_type,
                        usage_events_t.c.session_id,
                        usage_events_t.c.runtime_type,
                        usage_events_t.c.user_id,
                    )
                )
            ).all()
        return [
            UsageSessionRow(
                hour_bucket=str(row[0]),
                event_type=str(row[1]),
                session_id=str(row[2]),
                runtime_type=row[3],
                user_id=row[4],
                count=int(row[5] or 0),
            )
            for row in rows
        ]

    async def usage_connector_online(
        self, *, start_hour: str, end_hour: str
    ) -> list[UsageConnectorRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.connector_id,
                        func.max(usage_events_t.c.device_os).label("device_os"),
                    )
                    .where(
                        _hour_range(start_hour, end_hour),
                        usage_events_t.c.event_type == EVENT_CONNECTOR_ONLINE,
                        usage_events_t.c.connector_id.is_not(None),
                    )
                    .group_by(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.connector_id,
                    )
                )
            ).all()
        return [
            UsageConnectorRow(
                hour_bucket=str(row[0]),
                connector_id=str(row[1]),
                device_os=row[2],
            )
            for row in rows
        ]

    async def usage_durations(
        self,
        *,
        start_hour: str,
        end_hour: str,
        event_type: str,
        outcomes: tuple[str, ...] | None = None,
        limit: int = 200_000,
    ) -> list[UsageDurationRow]:
        conditions = [
            _hour_range(start_hour, end_hour),
            usage_events_t.c.event_type == event_type,
            usage_events_t.c.duration_ms.is_not(None),
        ]
        if outcomes:
            conditions.append(usage_events_t.c.outcome.in_(outcomes))
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        usage_events_t.c.hour_bucket,
                        usage_events_t.c.runtime_type,
                        usage_events_t.c.duration_ms,
                    )
                    .where(*conditions)
                    .order_by(usage_events_t.c.occurred_at.desc())
                    .limit(limit)
                )
            ).all()
        return [
            UsageDurationRow(
                hour_bucket=str(row[0]),
                runtime_type=row[1],
                duration_ms=int(row[2]),
            )
            for row in rows
        ]

    async def count_active_usage_users(self, *, since: str) -> int:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(func.count(func.distinct(usage_events_t.c.user_id))).where(
                        usage_events_t.c.occurred_at >= since,
                        usage_events_t.c.user_id.is_not(None),
                    )
                )
            ).first()
        return int(row[0] or 0) if row is not None else 0

    async def users_created_between(
        self, *, start: str, end: str
    ) -> list[tuple[str, str]]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(users_t.c.id, users_t.c.created_at).where(
                        users_t.c.created_at >= start,
                        users_t.c.created_at < end,
                    )
                )
            ).all()
        return [(str(row[0]), str(row[1])) for row in rows]

    async def runtime_display_names(self) -> dict[str, str]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        connector_runtime_types_t.c.runtime_type,
                        connector_runtime_types_t.c.display_name,
                    ).order_by(connector_runtime_types_t.c.updated_at)
                )
            ).all()
        names: dict[str, str] = {}
        for runtime_type, display_name in rows:
            if isinstance(display_name, str) and display_name.strip():
                names[str(runtime_type)] = display_name.strip()
        return names

    async def count_active_runs(self) -> int:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(func.count()).select_from(session_active_runs_t)
                )
            ).first()
        return int(row[0] or 0) if row is not None else 0

    # --- inventory (stock metrics) -----------------------------------------

    async def usage_inventory_live(self, *, now: str) -> list[InventoryRow]:
        seen_7d = _shift_iso(now, days=-7)
        seen_30d = _shift_iso(now, days=-30)
        active = connectors_t.c.revoked == 0
        async with self._engine.connect() as conn:
            users_total = (
                await conn.execute(select(func.count()).select_from(users_t))
            ).scalar_one()
            admins = (
                await conn.execute(
                    select(func.count())
                    .select_from(users_t)
                    .where(users_t.c.role == "admin")
                )
            ).scalar_one()
            connectors_total = (
                await conn.execute(
                    select(func.count()).select_from(connectors_t).where(active)
                )
            ).scalar_one()
            by_os = (
                await conn.execute(
                    select(
                        func.coalesce(
                            connectors_t.c.device_os, literal_column("'unknown'")
                        ),
                        func.count(),
                    )
                    .where(active)
                    .group_by(connectors_t.c.device_os)
                )
            ).all()
            seen_7 = (
                await conn.execute(
                    select(func.count())
                    .select_from(connectors_t)
                    .where(active, connectors_t.c.last_seen_at >= seen_7d)
                )
            ).scalar_one()
            seen_30 = (
                await conn.execute(
                    select(func.count())
                    .select_from(connectors_t)
                    .where(active, connectors_t.c.last_seen_at >= seen_30d)
                )
            ).scalar_one()
            configured = (
                await conn.execute(
                    select(
                        device_runtimes_t.c.runtime_type,
                        func.count(func.distinct(device_runtimes_t.c.connector_id)),
                    )
                    .join(
                        connectors_t,
                        connectors_t.c.id == device_runtimes_t.c.connector_id,
                    )
                    .where(active, device_runtimes_t.c.config_json.is_not(None))
                    .group_by(device_runtimes_t.c.runtime_type)
                )
            ).all()
            discovered = (
                await conn.execute(
                    select(
                        connector_runtime_types_t.c.runtime_type,
                        func.count(
                            func.distinct(connector_runtime_types_t.c.connector_id)
                        ),
                    )
                    .join(
                        connectors_t,
                        connectors_t.c.id == connector_runtime_types_t.c.connector_id,
                    )
                    .where(active, connector_runtime_types_t.c.present == 1)
                    .group_by(connector_runtime_types_t.c.runtime_type)
                )
            ).all()
        rows = [
            InventoryRow(INVENTORY_USERS_TOTAL, "", float(users_total or 0)),
            InventoryRow(INVENTORY_USERS_ADMINS, "", float(admins or 0)),
            InventoryRow(INVENTORY_CONNECTORS_TOTAL, "", float(connectors_total or 0)),
            InventoryRow(INVENTORY_CONNECTORS_SEEN_7D, "", float(seen_7 or 0)),
            InventoryRow(INVENTORY_CONNECTORS_SEEN_30D, "", float(seen_30 or 0)),
        ]
        for os_name, count in by_os:
            rows.append(
                InventoryRow(
                    INVENTORY_CONNECTORS_BY_OS, str(os_name or "unknown"), float(count or 0)
                )
            )
        for runtime_type, count in configured:
            rows.append(
                InventoryRow(INVENTORY_RUNTIMES_CONFIGURED, str(runtime_type), float(count or 0))
            )
        for runtime_type, count in discovered:
            rows.append(
                InventoryRow(INVENTORY_RUNTIMES_DISCOVERED, str(runtime_type), float(count or 0))
            )
        return rows

    async def usage_inventory_snapshot_exists(self, snapshot_date: str) -> bool:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(usage_inventory_snapshots_t.c.metric_key)
                    .where(usage_inventory_snapshots_t.c.snapshot_date == snapshot_date)
                    .limit(1)
                )
            ).first()
        return row is not None

    async def replace_usage_inventory_snapshot(
        self,
        snapshot_date: str,
        rows: list[InventoryRow],
        *,
        computed_at: str,
    ) -> None:
        values = [
            {
                "snapshot_date": snapshot_date,
                "metric_key": row.metric_key,
                "dimension": row.dimension,
                "value": float(row.value),
                "computed_at": computed_at,
            }
            for row in rows
        ]
        async with self._engine.begin() as conn:
            await conn.execute(
                delete(usage_inventory_snapshots_t).where(
                    usage_inventory_snapshots_t.c.snapshot_date == snapshot_date
                )
            )
            if values:
                await conn.execute(insert(usage_inventory_snapshots_t), values)

    async def usage_inventory_snapshots(
        self, *, from_date: str, to_date: str
    ) -> list[InventorySnapshotRow]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        usage_inventory_snapshots_t.c.snapshot_date,
                        usage_inventory_snapshots_t.c.metric_key,
                        usage_inventory_snapshots_t.c.dimension,
                        usage_inventory_snapshots_t.c.value,
                    ).where(
                        usage_inventory_snapshots_t.c.snapshot_date >= from_date,
                        usage_inventory_snapshots_t.c.snapshot_date <= to_date,
                    )
                )
            ).all()
        return [
            InventorySnapshotRow(
                snapshot_date=str(row[0]),
                metric_key=str(row[1]),
                dimension=str(row[2] or ""),
                value=float(row[3] or 0),
            )
            for row in rows
        ]


def _hour_range(start_hour: str, end_hour: str) -> Any:
    return and_(
        usage_events_t.c.hour_bucket >= start_hour,
        usage_events_t.c.hour_bucket < end_hour,
    )


def _shift_iso(value: str, *, days: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    shifted = parsed + timedelta(days=days)
    return shifted.astimezone(UTC).isoformat().replace("+00:00", "Z")
