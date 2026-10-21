# Admin Usage API

Status: current. Introduced in 2.1.0; replaces the removed `/admin/dashboard/*`
endpoints, which recomputed statistics from raw timeline rows on every request.

Usage statistics are **event-driven**: the Server appends a usage fact the moment
platform activity happens, and the report only reads those facts plus a daily
inventory snapshot. Nothing is backfilled from history, so a deployment's report
starts on the day the `v2_42` migration was applied (see `range.dataSince`).

## Endpoints

Both require an admin bearer token (`require_admin`).

```text
GET /api/v2/admin/usage/report?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA zone>
GET /api/v2/admin/usage/live
```

`report` query parameters:

| Parameter | Default | Notes |
| --- | --- | --- |
| `tz` | `UTC` | IANA timezone used to split days. Clients send the viewer's browser zone. Unknown zones return `422`. |
| `to` | today in `tz` | Inclusive end date. |
| `from` | `to` − 29 days | Inclusive start date. `from > to` or a span above 366 days returns `422`. |

## How usage is collected

Facts live in the `usage_events` table. Every row has a UTC timestamp, its UTC
hour bucket (`YYYY-MM-DDTHH`), an event type, optional user / connector /
session / runtime identifiers, an optional `outcome`, an optional `duration_ms`
and an optional idempotency key (`dedupe_key`, unique). Connector and session
ids are plain text so usage history survives when a device or session is
deleted; `user_id` is set to `NULL` when the user is deleted.

| Event | Recorded when | Idempotency key | Notes |
| --- | --- | --- | --- |
| `user.active` | Any authenticated API call (`current_user_id`) or dashboard WebSocket connection | `active:{user}:{hour}` | Throttled in memory to one write per user per 5 minutes; at most one row per user per hour. |
| `session.created` | `POST /sessions/create-and-start` succeeded | `session:{sessionId}` | Only sessions created from the platform. |
| `session.viewed` | `GET /sessions/{id}/snapshot` succeeded — the call every client makes when it opens a session | none | One row per open. Repeats by the same user for the same session within 60 seconds (reconnects, refreshes) are folded in memory. |
| `message.sent` | `create-and-start`, `POST .../runtime/messages`, `POST .../runtime/steer` accepted by the Connector | `msg:{clientMessageId}` (none without a client id) | Counted at the platform intent, not when the timeline item arrives. |
| `turn.ended` | Connector notification `session.turnEnded` for a **takeover** session | `turn:{sessionId}:{turnId}` | `outcome` is `completed` / `interrupted` / `cancelled` / `failed`. `duration_ms` measures from the latest `message.sent` of the session; omitted when unknown or above 6 hours. Turns in read-only imported sessions are not platform usage. |
| `approval.requested` | `notice.upsert` with `type=interaction`, `interactionType=approval`, `status=open` | `approval:{noticeId}:requested` | |
| `approval.resolved` | Same notice reaching `resolved` / `closed` / `expired` / `cancelled` / `failed` | `approval:{noticeId}:resolved` | `outcome` is the final status; `duration_ms = resolvedAt − createdAt`. |
| `runtime.error` | Connector notification `runtime.error` | `rterr:{noticeId}` | |
| `connector.online` | Connector WebSocket became ready | none | Carries `device_os`. |

Writes are buffered in memory and flushed once per second
(`AGENT_SERVER_USAGE_FLUSH_INTERVAL_SECONDS`); a failed write is logged and never
fails the user's request. Rows older than `AGENT_SERVER_USAGE_RETENTION_DAYS`
(default 400) are pruned by the maintenance loop.

### Inventory snapshots

Stock metrics (users, devices, configured runtimes) are not events. The
maintenance loop records one snapshot per **UTC day** into
`usage_inventory_snapshots` shortly after the day starts, guarded by the
coordinator lock `usage-maintenance` so multiple workers do not duplicate it.
The report uses live values when the range ends today (or when no snapshot
exists for the end date) and the end date's snapshot otherwise; the choice is
reported in `devices.inventoryAsOf` (`"live"` or the snapshot date).

## Report semantics

### Timezone handling

Events are aggregated per UTC hour in SQL; the service then maps each hour onto
the local day of `tz`. Whole-hour timezones map exactly. Timezones with a
30/45-minute offset attribute an edge hour to the day in which its UTC hour
starts, so a day boundary can be off by up to that offset.

### Definitions

| Field | Meaning |
| --- | --- |
| `summary.activeUsers` | Distinct users with any usage event inside the range. |
| `summary.avgDau` | Mean of `daily[].activeUsers`. |
| `summary.newUsers` | Users whose account was created inside the range (local days). |
| `summary.wau` / `summary.mau` | Distinct users active in the 7 / 30 local days ending on `toDate`; the daily series carries the rolling value for every day, looking back before `fromDate`. |
| `summary.messages` | `message.sent` events. |
| `summary.sessions` | Distinct sessions that received a platform message in the range. |
| `summary.sessionViews` | `session.viewed` events: how many times sessions were opened in the range. |
| `summary.sessionsViewed` | Distinct sessions opened in the range. |
| `summary.sessionsReadOnly` | Sessions opened in the range that received no platform message in it — the ones people only read. `daily[]` carries all three per local day. |
| `summary.turns`, `turnFailureRate` | `turn.ended` events and the share with `outcome=failed` (`null` without turns). |
| `summary.turnDurationMs` | Nearest-rank p50 / p90 / p99 over completed turns with a known duration (newest 200 000 samples). |
| `summary.approvalsRequested` / `approvalsResolved` / `approvalWaitMs` | Approval events and percentiles of `approval.resolved` durations. |
| `summary.runtimeErrors` | `runtime.error` events. |
| `summary.connectorsOnline` | Distinct connectors with a `connector.online` event in the range. |
| `summary.totalUsers` / `totalConnectors` | Inventory values (see `devices.inventoryAsOf`). Revoked connectors are excluded. |
| `hourOfDay[]` | Messages and distinct active users per local hour of day across the range. |
| `users.segments` | Users with ≥1 message bucketed as light / medium / heavy; thresholds are the 50th and 80th percentile of per-user message counts (minimum 1). |
| `users.messageHistogram` | Per-user message counts bucketed at `0`, then edges at the 50th / 80th / 95th percentiles. |
| `users.retention[]` | Users created in the range grouped by signup week (Monday start). `d1` / `d7` / `d30` is the share active again within 1 / 7 / 30 days after signup, counting only members whose window has fully elapsed; `null` when nobody is eligible yet. |
| `runtimes[]` | Per `runtime_type` (the type bound to the session): messages, distinct sessions, distinct users, turns, failed turns, p50 turn duration, runtime errors, plus inventory counts of connectors that discovered / configured the type. `displayName` is the latest discovery display name reported by any connector, falling back to the key. |
| `devices.byOs[]` | Inventory connectors per OS plus distinct connectors that came online in the range. `unknown` when the Connector never reported an OS. |
| `devices.connectorsSeen7d` / `Seen30d` | Connectors with `last_seen_at` within 7 / 30 days of the inventory time. |
| `devices.inventoryDaily[]` | `users.total` and `connectors.total` from the daily snapshots inside the range. |
| `quality.turnOutcomes[]` / `approvalOutcomes[]` | Counts per outcome in a fixed order; unknown outcomes are appended. |

### Response shape

```json
{
  "range": {"fromDate": "2026-10-01", "toDate": "2026-10-30", "timezone": "Asia/Shanghai", "dataSince": "2026-10-10", "generatedAt": "..."},
  "summary": {"activeUsers": 12, "newUsers": 2, "avgDau": 4.5, "wau": 9, "mau": 12, "totalUsers": 40,
              "messages": 310, "sessions": 48, "sessionViews": 120, "sessionsViewed": 57, "sessionsReadOnly": 14,
              "turns": 290, "turnFailureRate": 0.03,
              "turnDurationMs": {"p50": 42000, "p90": 180000, "p99": 600000, "samples": 281},
              "approvalsRequested": 15, "approvalsResolved": 14,
              "approvalWaitMs": {"p50": 8000, "p90": 60000, "p99": 60000, "samples": 14},
              "runtimeErrors": 1, "connectorsOnline": 7, "totalConnectors": 11},
  "daily": [{"date": "2026-10-01", "activeUsers": 3, "newUsers": 0, "wau": 8, "mau": 12, "messages": 12,
             "sessions": 4, "sessionViews": 9, "sessionsViewed": 5, "sessionsReadOnly": 2,
             "turns": 11, "turnsFailed": 0, "turnDurationP50Ms": 40000, "turnDurationP90Ms": 90000,
             "approvalsRequested": 1, "approvalsResolved": 1, "runtimeErrors": 0, "connectorsOnline": 2}],
  "hourOfDay": [{"hour": 0, "messages": 0, "activeUsers": 0}],
  "users": {"segments": [{"segment": "light", "min": 1, "max": 5, "count": 6}],
            "messageHistogram": [{"label": "0", "min": 0, "max": 0, "count": 0}, {"label": "1-5", "min": 1, "max": 5, "count": 6}],
            "retention": [{"cohortStart": "2026-09-28", "cohortEnd": "2026-10-04", "cohortSize": 2, "d1": 0.5, "d7": 1.0, "d30": null}]},
  "runtimes": [{"runtimeType": "codex", "displayName": "Codex", "messages": 200, "sessions": 30, "activeUsers": 9,
                "turns": 190, "turnsFailed": 4, "turnDurationP50Ms": 41000, "runtimeErrors": 1,
                "configuredConnectors": 8, "discoveredConnectors": 10}],
  "devices": {"totalConnectors": 11, "connectorsSeen7d": 7, "connectorsSeen30d": 10,
              "byOs": [{"os": "macos", "connectors": 8, "connectorsOnline": 6}],
              "inventoryDaily": [{"date": "2026-10-10", "users": 40, "connectors": 11}],
              "inventoryAsOf": "live"},
  "quality": {"turnOutcomes": [{"outcome": "completed", "count": 280}], "turnDurationMs": {"p50": 42000, "p90": 180000, "p99": 600000, "samples": 281},
              "approvalOutcomes": [{"outcome": "resolved", "count": 14}], "approvalWaitMs": {"p50": 8000, "p90": 60000, "p99": 60000, "samples": 14},
              "runtimeErrors": 1},
  "serverTime": "..."
}
```

## Live endpoint

`GET /admin/usage/live` returns the instance state right now, independent of
any date range:

```json
{"onlineConnectors": 3, "totalConnectors": 11, "runningTurns": 2, "activeUsers15m": 4, "serverTime": "..."}
```

`onlineConnectors` comes from connector presence (not the SQL status column),
`runningTurns` from `session_active_runs`, and `activeUsers15m` from distinct
users with any usage event in the last 15 minutes.

## Client notes

- Web and Desktop send `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`
  and compute "today" in that zone; the page offers 7 / 30 / 90 day presets and a
  custom range capped at 366 days.
- Runtime rows are dynamic; clients must not assume a fixed set of runtime types.
- Android and iOS do not expose this report.
