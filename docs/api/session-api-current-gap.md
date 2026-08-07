# Session API Current Gap

Status: implementation audit for `v2-connector-refactor`.

This document is the working checklist between the target contract in
[`session-api-proposal.md`](./session-api-proposal.md) and the current Server
implementation. It exists to keep the backend cleanup ordered before the
frontend migration starts.

## Summary

Current backend state:

- Connector ingress endpoints are intentionally unchanged:
  - `POST /api/v2/connector/auth`
  - `POST /api/v2/connector/ingest`
  - `WS /api/v2/connector/ws`
- Runtime-scoped connector endpoints mostly exist under
  `/api/v2/connectors/{connectorId}/runtimes/{runtimeId}/...`.
- Session runtime action endpoints mostly exist under
  `/api/v2/sessions/{sessionId}/runtime/...`.
- Effective capability calculation has been moved away from persisted
  `sessions.status` and now uses runtime/session capability facts plus Server
  policy.
- Several old session aliases still exist as migration shims.
- Target session read endpoints exist. Remaining backend cleanup is now about
  migration shims and a few realtime event policy edges.

## Endpoint gap table

| Area | Target endpoint | Current status | Action |
| --- | --- | --- | --- |
| Session list | `GET /api/v2/sessions` | exists | Keep. Ensure response is treated as `SessionMeta` plus presence projection, not runtime truth. |
| Session create/start | `POST /api/v2/sessions/create-and-start` | exists | Keep. Verify selections flow through runtime-owned startup. |
| Session bind | `POST /api/v2/sessions` | exists | Keep only as bind/import path during migration. Do not use for new user tasks. |
| SessionMeta read | `GET /api/v2/sessions/{sessionId}/meta` | exists | Keep. Returns Server-owned metadata plus connector presence projection. |
| SessionMeta update | `PATCH /api/v2/sessions/{sessionId}/meta` | exists | Keep. Updates only Server-owned display metadata. |
| SessionMeta compatibility update | `PATCH /api/v2/sessions/{sessionId}` | removed | Use `/sessions/{sessionId}/meta`. |
| Read sessions | `POST /api/v2/sessions/read` with direct id array | exists | Keep as target. |
| Archive sessions | `POST /api/v2/sessions/archive` with direct id array | exists | Keep as target. |
| Unarchive sessions | `POST /api/v2/sessions/unarchive` with direct id array | exists | Keep as target. |
| Old read one | `POST /api/v2/sessions/{sessionId}/read` | removed | Use `/sessions/read` with a direct id array. |
| Old bulk read | `POST /api/v2/sessions/bulk-read` | removed | Use `/sessions/read` with a direct id array. |
| Old bulk archive | `POST /api/v2/sessions/bulk-archive` | removed | Use `/sessions/archive` or `/sessions/unarchive` with a direct id array. |
| SessionTimeline read | `GET /api/v2/sessions/{sessionId}/timeline` | exists | Keep. Returns durable timeline only. |
| Old timeline/state read | `GET /api/v2/sessions/{sessionId}/state` | removed | Use `/snapshot`, `/timeline`, and `/runtime/state` by data boundary. |
| Aggregate snapshot | `GET /api/v2/sessions/{sessionId}/snapshot` | exists | Keep. Verify runtime fields are live RPC/projection, not DB truth. |
| Runtime state read | `GET /api/v2/sessions/{sessionId}/runtime/state` | exists | Keep. Must use runtime live fact or explicit disconnected projection. |
| Old runtime state read | `GET /api/v2/sessions/{sessionId}/runtime-state` | removed | Use `/sessions/{sessionId}/runtime/state`. |
| Session capabilities | `GET /api/v2/sessions/{sessionId}/runtime/capabilities` | exists | Keep. Verify frontend uses this for action availability. |
| Session model catalog | `GET /api/v2/sessions/{sessionId}/runtime/catalogs/model` | exists | Keep as a session path to the runtime-level live catalog for existing session selectors. |
| Session permission catalog | `GET /api/v2/sessions/{sessionId}/runtime/catalogs/permission` | exists | Keep as a session path to the runtime-level live catalog for existing session selectors. |
| Runtime model catalog | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model` | exists | Keep for setup/new-session UI. |
| Runtime permission catalog | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission` | exists | Keep for setup/new-session UI. |
| Runtime capabilities | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/capabilities` | exists | Keep for dashboard/setup UI. |
| Runtime commands | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/commands` | exists | Keep. |
| Session commands list | `GET /api/v2/sessions/{sessionId}/runtime/commands` | exists | Keep. Must not use query matching. |
| Session commands execute | `POST /api/v2/sessions/{sessionId}/runtime/commands` | exists | Keep. Command execution returns RPC acceptance/result, later timeline updates are decoupled. |
| Old session commands | `GET/POST /api/v2/sessions/{sessionId}/commands` | removed | Use `/sessions/{sessionId}/runtime/commands`; frontend matches command text locally. |
| Selection update | `PATCH /api/v2/sessions/{sessionId}/runtime/selections` | exists | Keep. Runtime state should update immediately; effect boundary is runtime-owned. |
| Old selection update | `PATCH /api/v2/sessions/{sessionId}/state/selections` | removed | Use `/sessions/{sessionId}/runtime/selections`. |
| Send message | `POST /api/v2/sessions/{sessionId}/runtime/messages` | exists | Keep. |
| Old send message | `POST /api/v2/sessions/{sessionId}/messages` | removed | Use `/sessions/{sessionId}/runtime/messages`. |
| Steer | `POST /api/v2/sessions/{sessionId}/runtime/steer` | exists | Keep. |
| Old steer | `POST /api/v2/sessions/{sessionId}/steer` | removed | Use `/sessions/{sessionId}/runtime/steer`. |
| Interrupt | `POST /api/v2/sessions/{sessionId}/runtime/interrupt` | exists | Keep. If runtime reports no active turn, runtime state/capability should converge to idle/unavailable. |
| Old interrupt | `POST /api/v2/sessions/{sessionId}/interrupt` | removed | Use `/sessions/{sessionId}/runtime/interrupt`. |
| Runtime notices read | `GET /api/v2/sessions/{sessionId}/runtime/notices` | exists | Keep. Must be non-durable runtime truth. |
| Runtime notice response | `POST /api/v2/sessions/{sessionId}/runtime/notices/{noticeId}/respond` | exists | Keep. |
| Old interaction response | `POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond` | removed | Use `/sessions/{sessionId}/runtime/notices/{noticeId}/respond`. |
| Event recovery | `GET /api/v2/sessions/{sessionId}/events` | exists | Keep for durable meta/timeline recovery only. Do not recover runtime live facts from DB. |
| Session WS | `WS /api/v2/sessions/{sessionId}/ws` | exists | Keep. Runtime event names are the active contract; old session/notice compatibility events have been removed. |
| Dashboard WS | `WS /api/v2/dashboard/ws` | exists | Keep. Do not mix dashboard lifecycle with session lifecycle. |
| Old dashboard SSE | `GET /api/v2/sessions/events/dashboard` | removed | Use `/dashboard/ws`. |

## Realtime gap table

| Target event | Current status | Action |
| --- | --- | --- |
| `session.subscribed` | exists | Keep. |
| `session.meta.updated` | exists for connector invalidation pushes and event recovery | Frontend should use this for durable SessionMeta updates. |
| `timeline.item_created` | exists | Keep. Must be emitted for ingest and connector WS timeline upserts. |
| `timeline.item_updated` | exists | Keep. Must be emitted for content-hash changes. |
| `timeline.snapshot` | exists | Keep only for explicit snapshot/recovery cases. |
| `runtime.state.updated` | exists for connector invalidation pushes | Use as the runtime state truth. |
| `runtime.notice.snapshot` | exists for connector invalidation pushes | Use as the runtime notice snapshot. Notices remain non-durable runtime truth. |
| `runtime.notice.updated` | exists for connector invalidation pushes and event recovery | Use as the runtime notice update. Notices remain non-durable runtime truth. |
| `runtime.capability.updated` | exists for session WS capability projections and event recovery | Use as the scoped effective capability update. |
| `runtime.catalog.updated` | not implemented by design yet; legacy catalog update notifications are rejected | Keep live catalog reads as the source. Add this event only when a runtime actually pushes catalog invalidations. |
| `runtime.refetch_required` | not implemented by design yet | Add only when a runtime reports missed live facts. Current durable timeline overflow uses `session.refetch_required`. |
| `session.refetch_required` | exists | Restrict to durable meta/timeline recovery. |

## Required backend sequence

1. Add explicit code comments for remaining compatibility session aliases so
   callers know the target migration path.
2. Keep old aliases until frontend migration is complete, then remove them in
   one cleanup commit.

## Acceptance for backend cleanup

Backend cleanup is complete when:

- the route list has a target endpoint for every row marked missing above;
- every old route has either been removed or has an inline migration comment;
- runtime state, notices, capabilities, catalogs, commands, and selections are
  not treated as durable Server truth;
- session WS emits durable timeline/meta events and runtime live events through
  distinct event names;
- backend tests for MVP, runtime config, and effective capability pass.
