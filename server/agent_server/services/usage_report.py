"""Build the admin usage report from recorded usage events.

Events are stored with UTC hour buckets. The repository maps every bucket onto
the local day of the requested timezone and aggregates per day in SQL, so the
rows it returns grow with the number of days (and, for rolling windows, active
user-days) rather than with the number of events. Whole-hour timezones map
exactly; timezones with a 30 or 45 minute offset attribute the edge hour to the
day its UTC hour starts in, so day boundaries can be off by up to that offset.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from agent_server.core.models import (
    UsageBucket,
    UsageDailyPoint,
    UsageDevicesSection,
    UsageHourPoint,
    UsageInventoryPoint,
    UsageLiveResponse,
    UsageOsRow,
    UsageOutcomeRow,
    UsagePercentiles,
    UsageQualitySection,
    UsageRange,
    UsageReportResponse,
    UsageRetentionCohort,
    UsageRuntimeRow,
    UsageSegment,
    UsageSummary,
    UsageUsersSection,
)
from agent_server.core.usage import (
    EVENT_APPROVAL_REQUESTED,
    EVENT_APPROVAL_RESOLVED,
    EVENT_MESSAGE_SENT,
    EVENT_RUNTIME_ERROR,
    EVENT_TURN_ENDED,
    INVENTORY_CONNECTORS_BY_OS,
    INVENTORY_CONNECTORS_SEEN_7D,
    INVENTORY_CONNECTORS_SEEN_30D,
    INVENTORY_CONNECTORS_TOTAL,
    INVENTORY_RUNTIMES_CONFIGURED,
    INVENTORY_RUNTIMES_DISCOVERED,
    INVENTORY_USERS_TOTAL,
    TURN_OUTCOME_COMPLETED,
    TURN_OUTCOME_FAILED,
    InventoryRow,
    InventorySnapshotRow,
    UsageConnectorTotalsRow,
    UsageCountRow,
    UsageDurationStatsRow,
    UsageRuntimeReachRow,
    UsageSessionTotalsRow,
    UsageUserActivity,
)
from agent_server.core.utc import utc_now
from agent_server.services.connector_presence import (
    ConnectorPresencePort,
    connector_online_statuses,
)
from agent_server.services.repository_ports import UsageReportRepository

MAX_RANGE_DAYS = 366
ROLLING_LOOKBACK_DAYS = 29
RETENTION_WINDOW_DAYS = 30
LIVE_ACTIVE_WINDOW_SECONDS = 15 * 60
TURN_OUTCOME_ORDER = ("completed", "interrupted", "cancelled", "failed")
APPROVAL_OUTCOME_ORDER = ("resolved", "closed", "expired", "cancelled", "failed")


class UsageReportError(ValueError):
    pass


def resolve_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise UsageReportError(f"unsupported timezone: {name}") from exc


class UsageReportService:
    def __init__(self, store: UsageReportRepository) -> None:
        self._store = store

    @staticmethod
    def today(timezone: str) -> date:
        return datetime.now(resolve_timezone(timezone)).date()

    async def report(
        self,
        *,
        from_date: date,
        to_date: date,
        timezone: str,
    ) -> UsageReportResponse:
        tz = resolve_timezone(timezone)
        if from_date > to_date:
            raise UsageReportError("from date must be before or equal to to date")
        if (to_date - from_date).days + 1 > MAX_RANGE_DAYS:
            raise UsageReportError(f"range must not exceed {MAX_RANGE_DAYS} days")
        now = datetime.now(UTC)
        today_local = now.astimezone(tz).date()
        clock = _LocalClock(tz)
        days = _date_range(from_date, to_date)

        range_start = clock.hour_key(from_date)
        range_end = clock.hour_key(to_date + timedelta(days=1))
        # Rolling windows need activity before the range; retention needs the
        # days after a signup, capped at today.
        wide_start_date = from_date - timedelta(days=ROLLING_LOOKBACK_DAYS)
        wide_end_date = min(
            to_date + timedelta(days=RETENTION_WINDOW_DAYS),
            max(today_local, to_date),
        )
        wide_start = clock.hour_key(wide_start_date)
        wide_end = clock.hour_key(wide_end_date + timedelta(days=1))

        # Queries run one after another on purpose: running them concurrently
        # would hold one pooled connection per query for every report.
        in_range = {"start_hour": range_start, "end_hour": range_end, "timezone": timezone}
        counts = await self._store.usage_event_counts(**in_range)
        user_activity = await self._store.usage_user_activity(
            **in_range, days_start_hour=wide_start, days_end_hour=wide_end
        )
        session_totals = await self._store.usage_session_totals(**in_range)
        runtime_reach = await self._store.usage_runtime_reach(
            start_hour=range_start, end_hour=range_end
        )
        connector_totals = await self._store.usage_connector_totals(**in_range)
        turn_durations = await self._store.usage_duration_stats(
            **in_range,
            event_type=EVENT_TURN_ENDED,
            outcomes=(TURN_OUTCOME_COMPLETED,),
        )
        approval_durations = await self._store.usage_duration_stats(
            **in_range, event_type=EVENT_APPROVAL_RESOLVED
        )
        created_users = await self._store.users_created_between(
            start=clock.utc_iso(from_date),
            end=clock.utc_iso(to_date + timedelta(days=1)),
        )
        names = await self._store.runtime_display_names()
        first_event_date = await self._store.usage_first_event_date()
        snapshots = await self._store.usage_inventory_snapshots(
            from_date=from_date.isoformat(), to_date=to_date.isoformat()
        )
        inventory_rows, inventory_as_of = await self._inventory(
            snapshots, to_date=to_date, today=today_local, now=now
        )

        builder = _ReportBuilder(clock=clock, days=days, today=today_local)
        builder.add_counts(counts)
        builder.add_users(user_activity)
        builder.add_sessions(session_totals)
        builder.add_runtime_reach(runtime_reach)
        builder.add_connectors(connector_totals)
        builder.add_turn_durations(turn_durations)
        builder.add_approval_durations(approval_durations)
        builder.add_new_users(created_users)
        inventory = _InventoryView.from_rows(inventory_rows)
        generated_at = utc_now()
        return builder.build(
            range_=UsageRange(
                fromDate=from_date.isoformat(),
                toDate=to_date.isoformat(),
                timezone=timezone,
                dataSince=first_event_date,
                generatedAt=generated_at,
            ),
            inventory=inventory,
            inventory_as_of=inventory_as_of,
            snapshots=snapshots,
            runtime_names=names,
            server_time=generated_at,
        )

    async def live(self, *, presence: ConnectorPresencePort) -> UsageLiveResponse:
        connector_ids = await self._store.active_connector_ids()
        statuses = await connector_online_statuses(presence, connector_ids)
        online = sum(1 for is_online in statuses.values() if is_online)
        running = await self._store.count_active_runs()
        since = _iso(datetime.now(UTC) - timedelta(seconds=LIVE_ACTIVE_WINDOW_SECONDS))
        active = await self._store.count_active_usage_users(since=since)
        return UsageLiveResponse(
            onlineConnectors=online,
            totalConnectors=len(connector_ids),
            runningTurns=running,
            activeUsers15m=active,
            serverTime=utc_now(),
        )

    async def _inventory(
        self,
        snapshots: list[InventorySnapshotRow],
        *,
        to_date: date,
        today: date,
        now: datetime,
    ) -> tuple[list[InventoryRow], str]:
        if to_date < today:
            key = to_date.isoformat()
            rows = [
                InventoryRow(row.metric_key, row.dimension, row.value)
                for row in snapshots
                if row.snapshot_date == key
            ]
            if rows:
                return rows, key
        return await self._store.usage_inventory_live(now=_iso(now)), "live"


# --- time helpers -----------------------------------------------------------


class _LocalClock:
    """Local day boundaries of one timezone, as UTC hour buckets and instants."""

    def __init__(self, tz: ZoneInfo) -> None:
        self._tz = tz

    def hour_key(self, day: date) -> str:
        """UTC hour bucket in which the local day starts."""

        return self.day_start_utc(day).strftime("%Y-%m-%dT%H")

    def utc_iso(self, day: date) -> str:
        return _iso(self.day_start_utc(day))

    def day_start_utc(self, day: date) -> datetime:
        return datetime.combine(day, time.min, tzinfo=self._tz).astimezone(UTC)

    def local_date(self, iso_utc: str) -> date:
        parsed = datetime.fromisoformat(iso_utc)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(self._tz).date()


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _date_range(from_date: date, to_date: date) -> list[date]:
    count = (to_date - from_date).days
    return [from_date + timedelta(days=offset) for offset in range(count + 1)]


# --- aggregation ------------------------------------------------------------


@dataclass
class _DayAgg:
    messages: int = 0
    turns: int = 0
    turns_failed: int = 0
    approvals_requested: int = 0
    approvals_resolved: int = 0
    runtime_errors: int = 0
    new_users: int = 0
    users: set[str] = field(default_factory=set)
    sessions: int = 0
    session_views: int = 0
    sessions_viewed: int = 0
    sessions_read_only: int = 0
    connectors: int = 0
    turn_durations: UsagePercentiles = field(default_factory=UsagePercentiles)


@dataclass
class _RuntimeAgg:
    messages: int = 0
    turns: int = 0
    turns_failed: int = 0
    runtime_errors: int = 0
    sessions: int = 0
    users: int = 0
    turn_duration_p50: int | None = None


@dataclass(frozen=True)
class _InventoryView:
    users_total: int
    connectors_total: int
    seen_7d: int
    seen_30d: int
    by_os: dict[str, int]
    configured: dict[str, int]
    discovered: dict[str, int]

    @classmethod
    def from_rows(cls, rows: list[InventoryRow]) -> _InventoryView:
        scalars: dict[str, int] = {}
        by_os: dict[str, int] = {}
        configured: dict[str, int] = {}
        discovered: dict[str, int] = {}
        for row in rows:
            value = round(row.value)
            if row.metric_key == INVENTORY_CONNECTORS_BY_OS:
                by_os[row.dimension or "unknown"] = value
            elif row.metric_key == INVENTORY_RUNTIMES_CONFIGURED:
                configured[row.dimension] = value
            elif row.metric_key == INVENTORY_RUNTIMES_DISCOVERED:
                discovered[row.dimension] = value
            else:
                scalars[row.metric_key] = value
        return cls(
            users_total=scalars.get(INVENTORY_USERS_TOTAL, 0),
            connectors_total=scalars.get(INVENTORY_CONNECTORS_TOTAL, 0),
            seen_7d=scalars.get(INVENTORY_CONNECTORS_SEEN_7D, 0),
            seen_30d=scalars.get(INVENTORY_CONNECTORS_SEEN_30D, 0),
            by_os=by_os,
            configured=configured,
            discovered=discovered,
        )


class _ReportBuilder:
    def __init__(self, *, clock: _LocalClock, days: list[date], today: date) -> None:
        self._clock = clock
        self._days = days
        self._today = today
        self._daily: dict[str, _DayAgg] = {day.isoformat(): _DayAgg() for day in days}
        self._runtimes: dict[str, _RuntimeAgg] = defaultdict(_RuntimeAgg)
        self._turn_outcomes: Counter[str] = Counter()
        self._approval_outcomes: Counter[str] = Counter()
        self._hour_messages: Counter[int] = Counter()
        self._hour_users: dict[int, int] = {}
        self._user_days: dict[str, set[int]] = defaultdict(set)
        self._user_messages: Counter[str] = Counter()
        self._sessions = UsageSessionTotalsRow(None, 0, 0, 0, 0)
        self._connectors = 0
        self._os_online: dict[str, int] = {}
        self._turn_durations = UsagePercentiles()
        self._approval_durations = UsagePercentiles()
        self._signups: list[tuple[str, date]] = []

    # --- inputs -------------------------------------------------------------

    def add_counts(self, rows: list[UsageCountRow]) -> None:
        for row in rows:
            agg = self._daily.get(row.local_date)
            if agg is None:
                continue
            runtime = self._runtimes[row.runtime_type] if row.runtime_type else None
            if row.event_type == EVENT_MESSAGE_SENT:
                agg.messages += row.count
                self._hour_messages[row.local_hour] += row.count
                if runtime is not None:
                    runtime.messages += row.count
            elif row.event_type == EVENT_TURN_ENDED:
                agg.turns += row.count
                outcome = row.outcome or "unknown"
                self._turn_outcomes[outcome] += row.count
                failed = row.count if outcome == TURN_OUTCOME_FAILED else 0
                agg.turns_failed += failed
                if runtime is not None:
                    runtime.turns += row.count
                    runtime.turns_failed += failed
            elif row.event_type == EVENT_APPROVAL_REQUESTED:
                agg.approvals_requested += row.count
            elif row.event_type == EVENT_APPROVAL_RESOLVED:
                agg.approvals_resolved += row.count
                self._approval_outcomes[row.outcome or "unknown"] += row.count
            elif row.event_type == EVENT_RUNTIME_ERROR:
                agg.runtime_errors += row.count
                if runtime is not None:
                    runtime.runtime_errors += row.count

    def add_users(self, activity: UsageUserActivity) -> None:
        for row in activity.days:
            self._user_days[row.user_id].add(date.fromisoformat(row.local_date).toordinal())
            agg = self._daily.get(row.local_date)
            if agg is None:
                continue
            agg.users.add(row.user_id)
            self._user_messages[row.user_id] += row.messages
        self._hour_users = dict(activity.hour_of_day)

    def add_sessions(self, rows: list[UsageSessionTotalsRow]) -> None:
        for row in rows:
            if row.local_date is None:
                self._sessions = row
                continue
            agg = self._daily.get(row.local_date)
            if agg is None:
                continue
            agg.sessions = row.sessions
            agg.session_views = row.session_views
            agg.sessions_viewed = row.sessions_viewed
            agg.sessions_read_only = row.sessions_read_only

    def add_runtime_reach(self, rows: list[UsageRuntimeReachRow]) -> None:
        for row in rows:
            runtime = self._runtimes[row.runtime_type]
            runtime.sessions = row.sessions
            runtime.users = row.users

    def add_connectors(self, rows: list[UsageConnectorTotalsRow]) -> None:
        for row in rows:
            if row.local_date is not None:
                agg = self._daily.get(row.local_date)
                if agg is not None:
                    agg.connectors = row.connectors
            elif row.device_os is not None:
                self._os_online[row.device_os] = row.connectors
            else:
                self._connectors = row.connectors

    def add_turn_durations(self, rows: list[UsageDurationStatsRow]) -> None:
        for row in rows:
            if row.local_date is not None:
                agg = self._daily.get(row.local_date)
                if agg is not None:
                    agg.turn_durations = _percentiles(row)
            elif row.runtime_type is not None:
                self._runtimes[row.runtime_type].turn_duration_p50 = row.p50
            else:
                self._turn_durations = _percentiles(row)

    def add_approval_durations(self, rows: list[UsageDurationStatsRow]) -> None:
        for row in rows:
            if row.local_date is None and row.runtime_type is None:
                self._approval_durations = _percentiles(row)

    def add_new_users(self, rows: list[tuple[str, str]]) -> None:
        for user_id, created_at in rows:
            signup = self._clock.local_date(created_at)
            agg = self._daily.get(signup.isoformat())
            if agg is None:
                continue
            agg.new_users += 1
            self._signups.append((user_id, signup))

    # --- output -------------------------------------------------------------

    def build(
        self,
        *,
        range_: UsageRange,
        inventory: _InventoryView,
        inventory_as_of: str,
        snapshots: list[InventorySnapshotRow],
        runtime_names: dict[str, str],
        server_time: str,
    ) -> UsageReportResponse:
        start_ord = self._days[0].toordinal()
        end_ord = self._days[-1].toordinal()
        wau = _rolling_active_counts(self._user_days, 7, start_ord, end_ord)
        mau = _rolling_active_counts(self._user_days, 30, start_ord, end_ord)

        daily: list[UsageDailyPoint] = []
        for day in self._days:
            key = day.isoformat()
            agg = self._daily[key]
            daily.append(
                UsageDailyPoint(
                    date=key,
                    activeUsers=len(agg.users),
                    newUsers=agg.new_users,
                    wau=wau.get(day.toordinal(), 0),
                    mau=mau.get(day.toordinal(), 0),
                    messages=agg.messages,
                    sessions=agg.sessions,
                    sessionViews=agg.session_views,
                    sessionsViewed=agg.sessions_viewed,
                    sessionsReadOnly=agg.sessions_read_only,
                    turns=agg.turns,
                    turnsFailed=agg.turns_failed,
                    turnDurationP50Ms=agg.turn_durations.p50,
                    turnDurationP90Ms=agg.turn_durations.p90,
                    approvalsRequested=agg.approvals_requested,
                    approvalsResolved=agg.approvals_resolved,
                    runtimeErrors=agg.runtime_errors,
                    connectorsOnline=agg.connectors,
                )
            )

        active_users = set()
        for agg in self._daily.values():
            active_users.update(agg.users)
        total_messages = sum(point.messages for point in daily)
        total_turns = sum(point.turns for point in daily)
        total_failed = sum(point.turnsFailed for point in daily)
        turn_pct = self._turn_durations
        approval_pct = self._approval_durations
        approvals_requested = sum(point.approvalsRequested for point in daily)
        approvals_resolved = sum(point.approvalsResolved for point in daily)
        runtime_errors = sum(point.runtimeErrors for point in daily)
        last = daily[-1]

        summary = UsageSummary(
            activeUsers=len(active_users),
            newUsers=sum(point.newUsers for point in daily),
            avgDau=round(sum(point.activeUsers for point in daily) / len(daily), 2),
            wau=last.wau,
            mau=last.mau,
            totalUsers=inventory.users_total,
            messages=total_messages,
            sessions=self._sessions.sessions,
            sessionViews=self._sessions.session_views,
            sessionsViewed=self._sessions.sessions_viewed,
            sessionsReadOnly=self._sessions.sessions_read_only,
            turns=total_turns,
            turnFailureRate=round(total_failed / total_turns, 4) if total_turns else None,
            turnDurationMs=turn_pct,
            approvalsRequested=approvals_requested,
            approvalsResolved=approvals_resolved,
            approvalWaitMs=approval_pct,
            runtimeErrors=runtime_errors,
            connectorsOnline=self._connectors,
            totalConnectors=inventory.connectors_total,
        )

        hour_of_day = [
            UsageHourPoint(
                hour=hour,
                messages=self._hour_messages.get(hour, 0),
                activeUsers=self._hour_users.get(hour, 0),
            )
            for hour in range(24)
        ]

        users = UsageUsersSection(
            segments=_segments(self._user_messages),
            messageHistogram=_histogram(self._user_messages),
            retention=_retention(self._signups, self._user_days, today=self._today),
        )

        runtime_keys = set(self._runtimes) | set(inventory.configured) | set(inventory.discovered)
        runtimes = [
            UsageRuntimeRow(
                runtimeType=key,
                displayName=runtime_names.get(key, key),
                messages=agg.messages,
                sessions=agg.sessions,
                activeUsers=agg.users,
                turns=agg.turns,
                turnsFailed=agg.turns_failed,
                turnDurationP50Ms=agg.turn_duration_p50,
                runtimeErrors=agg.runtime_errors,
                configuredConnectors=inventory.configured.get(key, 0),
                discoveredConnectors=inventory.discovered.get(key, 0),
            )
            for key, agg in sorted(
                ((key, self._runtimes[key]) for key in runtime_keys),
                key=lambda item: (-item[1].messages, item[0]),
            )
        ]

        os_keys = set(inventory.by_os) | set(self._os_online)
        by_os = [
            UsageOsRow(
                os=key,
                connectors=inventory.by_os.get(key, 0),
                connectorsOnline=self._os_online.get(key, 0),
            )
            for key in sorted(os_keys, key=lambda name: (-inventory.by_os.get(name, 0), name))
        ]
        devices = UsageDevicesSection(
            totalConnectors=inventory.connectors_total,
            connectorsSeen7d=inventory.seen_7d,
            connectorsSeen30d=inventory.seen_30d,
            byOs=by_os,
            inventoryDaily=_inventory_daily(snapshots),
            inventoryAsOf=inventory_as_of,
        )

        quality = UsageQualitySection(
            turnOutcomes=_outcome_rows(self._turn_outcomes, TURN_OUTCOME_ORDER),
            turnDurationMs=turn_pct,
            approvalOutcomes=_outcome_rows(self._approval_outcomes, APPROVAL_OUTCOME_ORDER),
            approvalWaitMs=approval_pct,
            runtimeErrors=runtime_errors,
        )

        return UsageReportResponse(
            range=range_,
            summary=summary,
            daily=daily,
            hourOfDay=hour_of_day,
            users=users,
            runtimes=runtimes,
            devices=devices,
            quality=quality,
            serverTime=server_time,
        )


def _rolling_active_counts(
    user_days: dict[str, set[int]],
    window: int,
    start_ord: int,
    end_ord: int,
) -> dict[int, int]:
    """Count users active within the trailing ``window`` days of each day.

    Each active day ``d`` covers days ``d .. d+window-1``. Coverage intervals
    per user are merged before being added to a difference array, so a user is
    counted once per day however often they were active.
    """

    diff: dict[int, int] = defaultdict(int)
    for days in user_days.values():
        current_lo: int | None = None
        current_hi = 0
        for day in sorted(days):
            lo, hi = day, day + window - 1
            if current_lo is None:
                current_lo, current_hi = lo, hi
            elif lo <= current_hi + 1:
                current_hi = max(current_hi, hi)
            else:
                _mark(diff, current_lo, current_hi, start_ord, end_ord)
                current_lo, current_hi = lo, hi
        if current_lo is not None:
            _mark(diff, current_lo, current_hi, start_ord, end_ord)
    result: dict[int, int] = {}
    running = 0
    for ordinal in range(start_ord, end_ord + 1):
        running += diff.get(ordinal, 0)
        result[ordinal] = running
    return result


def _mark(diff: dict[int, int], lo: int, hi: int, start_ord: int, end_ord: int) -> None:
    lo = max(lo, start_ord)
    hi = min(hi, end_ord)
    if lo > hi:
        return
    diff[lo] += 1
    diff[hi + 1] -= 1


def _percentiles(row: UsageDurationStatsRow) -> UsagePercentiles:
    return UsagePercentiles(p50=row.p50, p90=row.p90, p99=row.p99, samples=row.samples)


def _percentile(ordered: list[int], fraction: float) -> int:
    """Nearest-rank percentile of an ascending list."""

    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))
    return ordered[index]


def _segments(user_messages: Counter[str]) -> list[UsageSegment]:
    positive = sorted(value for value in user_messages.values() if value > 0)
    light_max = max(1, _percentile(positive, 0.5)) if positive else 1
    medium_max = max(light_max, _percentile(positive, 0.8)) if positive else light_max
    counts = Counter({"light": 0, "medium": 0, "heavy": 0})
    for value in positive:
        if value <= light_max:
            counts["light"] += 1
        elif value <= medium_max:
            counts["medium"] += 1
        else:
            counts["heavy"] += 1
    return [
        UsageSegment(segment="light", min=1, max=light_max, count=counts["light"]),
        UsageSegment(
            segment="medium",
            min=light_max + 1,
            max=max(medium_max, light_max + 1),
            count=counts["medium"],
        ),
        UsageSegment(segment="heavy", min=medium_max + 1, max=None, count=counts["heavy"]),
    ]


def _histogram(user_messages: Counter[str]) -> list[UsageBucket]:
    """Bucket users by messages sent; edges follow the distribution's quantiles."""

    values = sorted(user_messages.values())
    positive = [value for value in values if value > 0]
    edges = [1]
    if positive:
        for fraction in (0.5, 0.8, 0.95):
            edges.append(_percentile_lower(positive, fraction))
    edges = sorted({edge for edge in edges if edge >= 1})
    buckets: list[tuple[int, int | None]] = [(0, 0)]
    for index, edge in enumerate(edges):
        upper = edges[index + 1] - 1 if index + 1 < len(edges) else None
        if upper is not None and upper < edge:
            continue
        buckets.append((edge, upper))
    result: list[UsageBucket] = []
    for low, high in buckets:
        count = sum(
            1 for value in values if value >= low and (high is None or value <= high)
        )
        label = str(low) if high == low else (f"{low}+" if high is None else f"{low}-{high}")
        result.append(UsageBucket(label=label, min=low, max=high, count=count))
    return result


def _percentile_lower(ordered: list[int], fraction: float) -> int:
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * fraction)))
    return ordered[index]


def _retention(
    signups: list[tuple[str, date]],
    user_days: dict[str, set[int]],
    *,
    today: date,
) -> list[UsageRetentionCohort]:
    cohorts: dict[date, list[tuple[str, date]]] = defaultdict(list)
    for user_id, signup in signups:
        week_start = signup - timedelta(days=signup.weekday())
        cohorts[week_start].append((user_id, signup))
    result: list[UsageRetentionCohort] = []
    for week_start in sorted(cohorts):
        members = cohorts[week_start]
        result.append(
            UsageRetentionCohort(
                cohortStart=week_start.isoformat(),
                cohortEnd=(week_start + timedelta(days=6)).isoformat(),
                cohortSize=len(members),
                d1=_retained_share(members, user_days, 1, today),
                d7=_retained_share(members, user_days, 7, today),
                d30=_retained_share(members, user_days, 30, today),
            )
        )
    return result


def _retained_share(
    members: list[tuple[str, date]],
    user_days: dict[str, set[int]],
    horizon: int,
    today: date,
) -> float | None:
    """Share of members active again within ``horizon`` days after signing up.

    Only members whose window has fully elapsed are counted, so young cohorts
    report ``None`` instead of a misleadingly low rate.
    """

    eligible = 0
    retained = 0
    for user_id, signup in members:
        if signup + timedelta(days=horizon) > today:
            continue
        eligible += 1
        days = user_days.get(user_id)
        if not days:
            continue
        start = signup.toordinal() + 1
        end = signup.toordinal() + horizon
        if any(start <= day <= end for day in days):
            retained += 1
    if not eligible:
        return None
    return round(retained / eligible, 4)


def _outcome_rows(counts: Counter[str], order: tuple[str, ...]) -> list[UsageOutcomeRow]:
    extra = sorted(key for key in counts if key not in order)
    return [UsageOutcomeRow(outcome=key, count=counts.get(key, 0)) for key in [*order, *extra]]


def _inventory_daily(snapshots: list[InventorySnapshotRow]) -> list[UsageInventoryPoint]:
    by_date: dict[str, dict[str, int]] = defaultdict(dict)
    for row in snapshots:
        if row.metric_key in {INVENTORY_USERS_TOTAL, INVENTORY_CONNECTORS_TOTAL}:
            by_date[row.snapshot_date][row.metric_key] = round(row.value)
    return [
        UsageInventoryPoint(
            date=snapshot_date,
            users=values.get(INVENTORY_USERS_TOTAL, 0),
            connectors=values.get(INVENTORY_CONNECTORS_TOTAL, 0),
        )
        for snapshot_date, values in sorted(by_date.items())
    ]
