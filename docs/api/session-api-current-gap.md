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
- Several target session read endpoints and target realtime event names are
  not yet implemented.

## Endpoint gap table

| Area | Target endpoint | Current status | Action |
| --- | --- | --- | --- |
| Session list | `GET /api/v2/sessions` | exists | Keep. Ensure response is treated as `SessionMeta` plus presence projection, not runtime truth. |
| Session create/start | `POST /api/v2/sessions/create-and-start` | exists | Keep. Verify selections flow through runtime-owned startup. |
| Session bind | `POST /api/v2/sessions` | exists | Keep only as bind/import path during migration. Do not use for new user tasks. |
| SessionMeta read | `GET /api/v2/sessions/{sessionId}/meta` | exists | Keep. Returns Server-owned metadata plus connector presence projection. |
| SessionMeta update | `PATCH /api/v2/sessions/{sessionId}/meta` | exists | Keep. Updates only Server-owned display metadata. |
| SessionMeta compatibility update | `PATCH /api/v2/sessions/{sessionId}` | exists | Mark as migration shim or replace with `/meta` when frontend migrates. |
| Read sessions | `POST /api/v2/sessions/read` with direct id array | exists | Keep as target. |
| Archive sessions | `POST /api/v2/sessions/archive` with direct id array | exists | Keep as target. |
| Old read one | `POST /api/v2/sessions/{sessionId}/read` | exists | Compatibility shim. Remove after frontend migration. |
| Old bulk read | `POST /api/v2/sessions/bulk-read` | exists | Compatibility shim. Remove after frontend migration. |
| Old bulk archive | `POST /api/v2/sessions/bulk-archive` | exists | Compatibility shim. Remove after frontend migration. |
| SessionTimeline read | `GET /api/v2/sessions/{sessionId}/timeline` | exists | Keep. Returns durable timeline only. |
| Old timeline/state read | `GET /api/v2/sessions/{sessionId}/state` | exists | Rename/split. It must not be the long-term timeline API. |
| Aggregate snapshot | `GET /api/v2/sessions/{sessionId}/snapshot` | exists | Keep. Verify runtime fields are live RPC/projection, not DB truth. |
| Runtime state read | `GET /api/v2/sessions/{sessionId}/runtime/state` | exists | Keep. Must use runtime live fact or explicit disconnected projection. |
| Old runtime state read | `GET /api/v2/sessions/{sessionId}/runtime-state` | exists | Compatibility shim. Remove after frontend migration. |
| Session capabilities | `GET /api/v2/sessions/{sessionId}/runtime/capabilities` | exists | Keep. Verify frontend uses this for action availability. |
| Session model catalog | `GET /api/v2/sessions/{sessionId}/runtime/catalogs/model` | missing | Add if existing session selectors need session-scoped live catalogs. |
| Session permission catalog | `GET /api/v2/sessions/{sessionId}/runtime/catalogs/permission` | missing | Add if existing session selectors need session-scoped live catalogs. |
| Runtime model catalog | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/model` | exists | Keep for setup/new-session UI. |
| Runtime permission catalog | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/catalogs/permission` | exists | Keep for setup/new-session UI. |
| Runtime capabilities | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/capabilities` | exists | Keep for dashboard/setup UI. |
| Runtime commands | `GET /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/commands` | exists | Keep. |
| Session commands list | `GET /api/v2/sessions/{sessionId}/runtime/commands` | exists | Keep. Must not use query matching. |
| Session commands execute | `POST /api/v2/sessions/{sessionId}/runtime/commands` | exists | Keep. Command execution returns RPC acceptance/result, later timeline updates are decoupled. |
| Old session commands | `GET/POST /api/v2/sessions/{sessionId}/commands` | exists | Compatibility shim. Remove after frontend migration. |
| Selection update | `PATCH /api/v2/sessions/{sessionId}/runtime/selections` | exists | Keep. Runtime state should update immediately; effect boundary is runtime-owned. |
| Old selection update | `PATCH /api/v2/sessions/{sessionId}/state/selections` | exists | Compatibility shim. Remove after frontend migration. |
| Send message | `POST /api/v2/sessions/{sessionId}/runtime/messages` | exists | Keep. |
| Old send message | `POST /api/v2/sessions/{sessionId}/messages` | exists | Compatibility shim. Remove after frontend migration. |
| Steer | `POST /api/v2/sessions/{sessionId}/runtime/steer` | exists | Keep. |
| Old steer | `POST /api/v2/sessions/{sessionId}/steer` | exists | Compatibility shim. Remove after frontend migration. |
| Interrupt | `POST /api/v2/sessions/{sessionId}/runtime/interrupt` | exists | Keep. If runtime reports no active turn, runtime state/capability should converge to idle/unavailable. |
| Old interrupt | `POST /api/v2/sessions/{sessionId}/interrupt` | exists | Compatibility shim. Remove after frontend migration. |
| Runtime notices read | `GET /api/v2/sessions/{sessionId}/runtime/notices` | exists | Keep. Must be non-durable runtime truth. |
| Runtime notice response | `POST /api/v2/sessions/{sessionId}/runtime/notices/{noticeId}/respond` | exists | Keep. |
| Old interaction response | `POST /api/v2/sessions/{sessionId}/interactions/{noticeId}/respond` | exists | Compatibility shim. Remove after frontend migration. |
| Event recovery | `GET /api/v2/sessions/{sessionId}/events` | exists | Keep for durable meta/timeline recovery only. Do not recover runtime live facts from DB. |
| Session WS | `WS /api/v2/sessions/{sessionId}/ws` | exists | Keep. Event names still need migration. |
| Dashboard WS | target documented as `/api/v2/dashboard/ws` | current implementation exposes `/api/v2/ws` | Decide and align route/docs/frontend. Do not mix dashboard lifecycle with session lifecycle. |

## Realtime gap table

| Target event | Current status | Action |
| --- | --- | --- |
| `session.subscribed` | exists | Keep. |
| `session.meta.updated` | not consistently emitted | Add for durable SessionMeta changes. |
| `timeline.item_created` | exists | Keep. Must be emitted for ingest and connector WS timeline upserts. |
| `timeline.item_updated` | exists | Keep. Must be emitted for content-hash changes. |
| `timeline.snapshot` | exists | Keep only for explicit snapshot/recovery cases. |
| `runtime.state.updated` | exists for connector invalidation pushes; compatibility `session.status_changed` still carries state during migration | Frontend should migrate to this event as the runtime state truth. |
| `runtime.notice.snapshot` | exists for connector invalidation pushes; compatibility `notice.snapshot` remains during migration | Frontend should migrate to this event. Notices remain non-durable runtime truth. |
| `runtime.notice.updated` | exists for connector invalidation pushes; compatibility `notice.created` / `notice.updated` remain during migration | Frontend should migrate to this event. Notices remain non-durable runtime truth. |
| `runtime.capability.updated` | exists for session WS capability projections; compatibility `effectiveCapabilities` remains on `session.status_changed` | Keep while frontend migrates to the explicit runtime event. |
| `runtime.catalog.updated` | not clearly implemented | Add only if runtime pushes catalog changes; otherwise live reads are sufficient. |
| `runtime.refetch_required` | not clearly implemented | Add for missed runtime live facts; Web should call the relevant runtime endpoint. |
| `session.refetch_required` | exists | Restrict to durable meta/timeline recovery. |

## Required backend sequence

1. Add explicit code comments for compatibility session aliases so callers know
   the target migration path.
2. Add missing target read endpoints:
   - `GET /sessions/{sessionId}/meta`
   - `PATCH /sessions/{sessionId}/meta`
   - `GET /sessions/{sessionId}/timeline`
   - session-scoped runtime catalog reads if the frontend cannot rely on
     connector-scoped catalog reads for existing sessions.
3. Align dashboard realtime route naming or update docs to the implemented
   route. This must be decided before frontend migration.
4. Migrate session WS event naming from compatibility runtime payloads to
   explicit `runtime.*` events.
5. Keep old aliases until frontend migration is complete, then remove them in
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
