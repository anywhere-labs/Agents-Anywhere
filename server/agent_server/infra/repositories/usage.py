from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence

from sqlalchemy import (
    TIMESTAMP,
    Date,
    Integer,
    Text,
    cast,
    extract,
    literal_column,
    tuple_,
)
from sqlalchemy.dialects.postgresql import ARRAY, aggregate_order_by
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
    UsageConnectorTotalsRow,
    UsageCountRow,
    UsageDurationStatsRow,
    UsageRuntimeReachRow,
    UsageSessionTotalsRow,
    UsageUserActivity,
    UsageUserDayRow,
)
from agent_server.infra.db import session_active_runs as session_active_runs_t
from agent_server.infra.db import usage_hourly_connectors as hourly_connectors_t
from agent_server.infra.db import usage_hourly_counts as hourly_counts_t
from agent_server.infra.db import usage_hourly_runtime_sessions as runtime_sessions_t
from agent_server.infra.db import usage_hourly_runtime_users as runtime_users_t
from agent_server.infra.db import usage_hourly_sessions as hourly_sessions_t
from agent_server.infra.db import usage_hourly_users as hourly_users_t
from agent_server.infra.repositories.store_support import *


class UsageRepositoryMixin:
    """SQL access for usage events, their hourly rollups and inventory snapshots."""

    # --- event writes -------------------------------------------------------

    async def insert_usage_events(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0
        async with self._engine.begin() as conn:
            # Only rows that survive the dedupe key reach the rollups, and both
            # commit together, so the rollups never drift from the events.
            inserted = (
                await conn.execute(
                    pg_insert(usage_events_t)
                    .values(rows)
                    .on_conflict_do_nothing()
                    .returning(*_ROLLUP_SOURCE_COLUMNS)
                )
            ).mappings().all()
            await _add_to_rollups(conn, inserted)
        return len(inserted)

    async def delete_usage_events_before(self, cutoff_hour_bucket: str) -> int:
        async with self._engine.begin() as conn:
            for table in _ROLLUP_TABLES:
                await conn.execute(
                    delete(table).where(table.c.hour_bucket < cutoff_hour_bucket)
                )
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
        self, *, start_hour: str, end_hour: str, timezone: str
    ) -> list[UsageCountRow]:
        local = _with_local_time(
            timezone,
            select(hourly_counts_t)
            .where(_hour_range(hourly_counts_t, start_hour, end_hour))
            .subquery(),
        )
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        local.c.local_date,
                        local.c.local_hour,
                        local.c.event_type,
                        local.c.runtime_type,
                        local.c.outcome,
                        local.c.count,
                        local.c.duration_sum,
                    )
                )
            ).all()
        return [
            UsageCountRow(
                local_date=row[0].isoformat(),
                local_hour=int(row[1]),
                event_type=str(row[2]),
                runtime_type=row[3] or None,
                outcome=row[4] or None,
                count=int(row[5] or 0),
                duration_sum=int(row[6] or 0),
            )
            for row in rows
        ]

    async def usage_user_activity(
        self,
        *,
        start_hour: str,
        end_hour: str,
        days_start_hour: str,
        days_end_hour: str,
        timezone: str,
    ) -> UsageUserActivity:
        """Active local days per user over ``days_*`` (which must contain the
        report range) and distinct users per local hour of day in the range."""

        hourly = (
            select(hourly_users_t)
            .where(_hour_range(hourly_users_t, days_start_hour, days_end_hour))
            .subquery()
        )
        local = _with_local_time(timezone, hourly)
        in_range = and_(local.c.hour_bucket >= start_hour, local.c.hour_bucket < end_hour)
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        local.c.local_date,
                        local.c.local_hour,
                        local.c.user_id,
                        func.sum(local.c.messages),
                        func.count(func.distinct(local.c.user_id)).filter(in_range),
                    ).group_by(
                        func.grouping_sets(
                            tuple_(local.c.local_date, local.c.user_id),
                            tuple_(local.c.local_hour),
                        )
                    )
                )
            ).all()
        days: list[UsageUserDayRow] = []
        hour_of_day: dict[int, int] = {}
        for local_date, local_hour, user_id, messages, users in rows:
            if local_hour is not None:
                hour_of_day[int(local_hour)] = int(users or 0)
            else:
                days.append(
                    UsageUserDayRow(
                        local_date=local_date.isoformat(),
                        user_id=str(user_id),
                        messages=int(messages or 0),
                    )
                )
        return UsageUserActivity(days=days, hour_of_day=hour_of_day)

    async def usage_session_totals(
        self, *, start_hour: str, end_hour: str, timezone: str
    ) -> list[UsageSessionTotalsRow]:
        hourly = (
            select(hourly_sessions_t)
            .where(_hour_range(hourly_sessions_t, start_hour, end_hour))
            .subquery()
        )
        local = _with_local_time(timezone, hourly)
        # One row per session and day plus one per session for the whole
        # range (local_date NULL), so "viewed but never messaged" is decided
        # per day and per range without returning sessions to Python.
        per_session = (
            select(
                local.c.local_date,
                local.c.session_id,
                func.sum(local.c.messages).label("messages"),
                func.sum(local.c.views).label("views"),
            )
            .group_by(
                func.grouping_sets(
                    tuple_(local.c.local_date, local.c.session_id),
                    tuple_(local.c.session_id),
                )
            )
            .subquery()
        )
        messaged = per_session.c.messages > 0
        viewed = per_session.c.views > 0
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        per_session.c.local_date,
                        func.count().filter(messaged),
                        func.count().filter(viewed),
                        func.count().filter(viewed, ~messaged),
                        func.coalesce(func.sum(per_session.c.views), 0),
                    ).group_by(per_session.c.local_date)
                )
            ).all()
        return [
            UsageSessionTotalsRow(
                local_date=row[0].isoformat() if row[0] is not None else None,
                sessions=int(row[1] or 0),
                sessions_viewed=int(row[2] or 0),
                sessions_read_only=int(row[3] or 0),
                session_views=int(row[4] or 0),
            )
            for row in rows
        ]

    async def usage_runtime_reach(
        self, *, start_hour: str, end_hour: str
    ) -> list[UsageRuntimeReachRow]:
        sessions = (
            select(
                runtime_sessions_t.c.runtime_type,
                func.count(func.distinct(runtime_sessions_t.c.session_id)).label("count"),
            )
            .where(_hour_range(runtime_sessions_t, start_hour, end_hour))
            .group_by(runtime_sessions_t.c.runtime_type)
            .subquery()
        )
        users = (
            select(
                runtime_users_t.c.runtime_type,
                func.count(func.distinct(runtime_users_t.c.user_id)).label("count"),
            )
            .where(_hour_range(runtime_users_t, start_hour, end_hour))
            .group_by(runtime_users_t.c.runtime_type)
            .subquery()
        )
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    # A runtime with users always has sessions in the same hours.
                    select(sessions.c.runtime_type, sessions.c.count, users.c.count).select_from(
                        sessions.outerjoin(users, users.c.runtime_type == sessions.c.runtime_type)
                    )
                )
            ).all()
        return [
            UsageRuntimeReachRow(
                runtime_type=str(row[0]),
                sessions=int(row[1] or 0),
                users=int(row[2] or 0),
            )
            for row in rows
        ]

    async def usage_connector_totals(
        self, *, start_hour: str, end_hour: str, timezone: str
    ) -> list[UsageConnectorTotalsRow]:
        hourly = (
            select(
                hourly_connectors_t.c.hour_bucket,
                hourly_connectors_t.c.connector_id,
                func.coalesce(
                    hourly_connectors_t.c.device_os, literal_column("'unknown'")
                ).label("device_os"),
            )
            .where(_hour_range(hourly_connectors_t, start_hour, end_hour))
            .subquery()
        )
        local = _with_local_time(timezone, hourly)
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        local.c.local_date,
                        local.c.device_os,
                        func.count(func.distinct(local.c.connector_id)),
                    ).group_by(
                        func.grouping_sets(
                            tuple_(local.c.local_date),
                            tuple_(local.c.device_os),
                            tuple_(),
                        )
                    )
                )
            ).all()
        return [
            UsageConnectorTotalsRow(
                local_date=row[0].isoformat() if row[0] is not None else None,
                device_os=str(row[1]) if row[1] is not None else None,
                connectors=int(row[2] or 0),
            )
            for row in rows
        ]

    async def usage_duration_stats(
        self,
        *,
        start_hour: str,
        end_hour: str,
        timezone: str,
        event_type: str,
        outcomes: tuple[str, ...] | None = None,
    ) -> list[UsageDurationStatsRow]:
        conditions = [
            usage_events_t.c.event_type == event_type,
            usage_events_t.c.duration_ms.is_not(None),
        ]
        if outcomes:
            conditions.append(usage_events_t.c.outcome.in_(outcomes))
        # Percentiles need every sample, so durations are localized per event.
        events = _with_local_time(
            timezone,
            select(
                usage_events_t.c.hour_bucket,
                func.coalesce(usage_events_t.c.runtime_type, "").label("runtime_type"),
                usage_events_t.c.duration_ms,
            )
            .where(_hour_range(usage_events_t, start_hour, end_hour), *conditions)
            .subquery(),
        )
        duration = events.c.duration_ms
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(
                        events.c.local_date,
                        events.c.runtime_type,
                        func.percentile_disc(0.5).within_group(duration),
                        func.percentile_disc(0.9).within_group(duration),
                        func.percentile_disc(0.99).within_group(duration),
                        func.count(),
                    ).group_by(
                        func.grouping_sets(
                            tuple_(events.c.local_date),
                            tuple_(events.c.runtime_type),
                            tuple_(),
                        )
                    )
                )
            ).all()
        return [
            UsageDurationStatsRow(
                local_date=row[0].isoformat() if row[0] is not None else None,
                runtime_type=row[1] or None,
                p50=int(row[2]),
                p90=int(row[3]),
                p99=int(row[4]),
                samples=int(row[5] or 0),
            )
            for row in rows
            # Grouping by runtime type yields a "" row for events without
            # one; the range total over no samples yields a NULL row.
            if row[5] and (row[1] is None or row[1])
        ]

    async def count_active_usage_users(self, *, since: str) -> int:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(func.count(func.distinct(usage_events_t.c.user_id))).where(
                        # The hour bucket bound lets the planner use
                        # idx_usage_events_hour; occurred_at has no index.
                        usage_events_t.c.hour_bucket >= since[:13],
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
        runtime_types = connector_runtime_types_t.c
        display_name = func.btrim(runtime_types.display_name)
        # The newest non-empty name per runtime type, chosen in SQL instead of
        # reading one row per connector and runtime type.
        latest = func.array_agg(
            aggregate_order_by(display_name, runtime_types.updated_at.desc()),
            type_=ARRAY(Text),
        )[1]
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(runtime_types.runtime_type, latest)
                    .where(display_name != "")
                    .group_by(runtime_types.runtime_type)
                )
            ).all()
        return {str(runtime_type): str(name) for runtime_type, name in rows}

    async def active_connector_ids(self) -> list[str]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(connectors_t.c.id).where(connectors_t.c.revoked == 0)
                )
            ).all()
        return [str(row[0]) for row in rows]

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


def _with_local_time(timezone: str, rows: Any) -> Any:
    """Add the local date and hour of each row's UTC hour bucket.

    Callers group by hour first so the conversion runs once per hour and key
    rather than once per event. The local values live in a subquery so outer
    queries group by plain columns: PostgreSQL does not treat two copies of an
    expression with a bound timezone parameter as the same GROUP BY expression.
    """

    utc = cast(rows.c.hour_bucket.concat(":00:00+00:00"), TIMESTAMP(timezone=True))
    local = func.timezone(timezone, utc)
    return select(
        *rows.c,
        cast(local, Date).label("local_date"),
        cast(extract("hour", local), Integer).label("local_hour"),
    ).subquery()


def _hour_range(table: Any, start_hour: str, end_hour: str) -> Any:
    return and_(table.c.hour_bucket >= start_hour, table.c.hour_bucket < end_hour)


# --- rollup maintenance -------------------------------------------------------

_ROLLUP_TABLES = (
    hourly_counts_t,
    hourly_users_t,
    hourly_sessions_t,
    runtime_sessions_t,
    runtime_users_t,
    hourly_connectors_t,
)

_ROLLUP_SOURCE_COLUMNS = (
    usage_events_t.c.hour_bucket,
    usage_events_t.c.event_type,
    usage_events_t.c.user_id,
    usage_events_t.c.connector_id,
    usage_events_t.c.session_id,
    usage_events_t.c.runtime_type,
    usage_events_t.c.device_os,
    usage_events_t.c.outcome,
    usage_events_t.c.duration_ms,
)


async def _add_to_rollups(conn: AsyncConnection, events: Sequence[Mapping[str, Any]]) -> None:
    """Add newly inserted events to the hourly rollups.

    The rules match the backfill in migration v2_45. Rows are upserted in key
    order so concurrent flushes lock rollup rows in the same order.
    """

    counts: dict[tuple[str, str, str, str], list[int]] = defaultdict(lambda: [0, 0])
    users: Counter[tuple[str, str]] = Counter()
    sessions: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    runtime_sessions: set[tuple[str, str, str]] = set()
    runtime_users: set[tuple[str, str, str]] = set()
    connectors: dict[tuple[str, str], str | None] = {}
    for event in events:
        hour, event_type = event["hour_bucket"], event["event_type"]
        user_id, session_id = event["user_id"], event["session_id"]
        runtime_type = event["runtime_type"] or ""
        message = event_type == EVENT_MESSAGE_SENT
        count = counts[(hour, event_type, runtime_type, event["outcome"] or "")]
        count[0] += 1
        count[1] += event["duration_ms"] or 0
        if user_id is not None:
            users[(hour, user_id)] += 1 if message else 0
        if session_id is not None and event_type in (EVENT_MESSAGE_SENT, EVENT_SESSION_VIEWED):
            sessions[(hour, session_id)][0 if message else 1] += 1
        if message and session_id is not None and runtime_type:
            runtime_sessions.add((hour, runtime_type, session_id))
            if user_id is not None:
                runtime_users.add((hour, runtime_type, user_id))
        if event_type == EVENT_CONNECTOR_ONLINE and event["connector_id"] is not None:
            key = (hour, event["connector_id"])
            current, device_os = connectors.get(key), event["device_os"]
            connectors[key] = max(filter(None, (current, device_os)), default=None)

    await _upsert_adding(
        conn,
        hourly_counts_t,
        [
            dict(zip(("hour_bucket", "event_type", "runtime_type", "outcome"), key))
            | {"count": value[0], "duration_sum": value[1]}
            for key, value in sorted(counts.items())
        ],
        ("count", "duration_sum"),
    )
    await _upsert_adding(
        conn,
        hourly_users_t,
        [
            {"hour_bucket": hour, "user_id": user_id, "messages": messages}
            for (hour, user_id), messages in sorted(users.items())
        ],
        ("messages",),
    )
    await _upsert_adding(
        conn,
        hourly_sessions_t,
        [
            {"hour_bucket": hour, "session_id": session_id, "messages": value[0], "views": value[1]}
            for (hour, session_id), value in sorted(sessions.items())
        ],
        ("messages", "views"),
    )
    await _insert_missing(
        conn,
        runtime_sessions_t,
        [
            {"hour_bucket": hour, "runtime_type": runtime_type, "session_id": session_id}
            for hour, runtime_type, session_id in sorted(runtime_sessions)
        ],
    )
    await _insert_missing(
        conn,
        runtime_users_t,
        [
            {"hour_bucket": hour, "runtime_type": runtime_type, "user_id": user_id}
            for hour, runtime_type, user_id in sorted(runtime_users)
        ],
    )
    if connectors:
        statement = pg_insert(hourly_connectors_t).values(
            [
                {"hour_bucket": hour, "connector_id": connector_id, "device_os": device_os}
                for (hour, connector_id), device_os in sorted(connectors.items())
            ]
        )
        # GREATEST ignores NULLs, so this keeps the per-hour max(device_os).
        await conn.execute(
            statement.on_conflict_do_update(
                index_elements=_primary_key(hourly_connectors_t),
                set_={
                    "device_os": func.greatest(
                        hourly_connectors_t.c.device_os, statement.excluded.device_os
                    )
                },
            )
        )


async def _upsert_adding(
    conn: AsyncConnection, table: Any, rows: list[dict[str, Any]], columns: tuple[str, ...]
) -> None:
    if not rows:
        return
    statement = pg_insert(table).values(rows)
    await conn.execute(
        statement.on_conflict_do_update(
            index_elements=_primary_key(table),
            set_={name: table.c[name] + statement.excluded[name] for name in columns},
        )
    )


async def _insert_missing(conn: AsyncConnection, table: Any, rows: list[dict[str, Any]]) -> None:
    if rows:
        await conn.execute(pg_insert(table).values(rows).on_conflict_do_nothing())


def _primary_key(table: Any) -> list[str]:
    return [column.name for column in table.primary_key.columns]


def _shift_iso(value: str, *, days: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    shifted = parsed + timedelta(days=days)
    return shifted.astimezone(UTC).isoformat().replace("+00:00", "Z")
