# Frontend API Migration Checklist

Status: draft migration checklist.

This document records frontend work that must happen after the backend runtime
protocol cleanup is complete. Do not start frontend migration from this
checklist until the backend compatibility shims and runtime ownership rules are
finished.

## Migration rule

Frontend code should use scoped REST paths and runtime-owned live reads:

- connector/runtime facts are read from `/connectors/{connectorId}/runtimes/{runtime}/...`;
- session/runtime facts are read from `/sessions/{sessionId}/runtime/...`;
- command fuzzy matching is frontend behavior after reading the full command list;
- selectors use live catalog reads when opened, not snapshot payloads or cached
  session fields;
- effective capability is the action availability contract.

Do not add new uses of:

```text
/agents/*
?connectorId=...
/sessions/{sessionId}/runtime-state
/sessions/{sessionId}/state/selections
/sessions/{sessionId}/commands
/sessions/{sessionId}/messages
/sessions/{sessionId}/interrupt
/sessions/{sessionId}/steer
/sessions/{sessionId}/interactions/{noticeId}/respond
/sessions/bulk-read
/sessions/bulk-archive
```

## API replacements

| Frontend use case | Old API | New API |
| --- | --- | --- |
| Runtime model catalog before creating a session | `GET /agents/{runtime}/model-catalog?connectorId=...` | `GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/model` |
| Runtime permission catalog before creating a session | `GET /agents/{runtime}/permission-catalog?connectorId=...` | `GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/permission` |
| Runtime-level capability for setup/new-session UI | `GET /connectors/{connectorId}/protocol/capabilities` or local derivation | `GET /connectors/{connectorId}/runtimes/{runtime}/capabilities` |
| Runtime-level commands | none or frontend-built list | `GET /connectors/{connectorId}/runtimes/{runtime}/commands` |
| Session live state | `GET /sessions/{sessionId}/runtime-state` | `GET /sessions/{sessionId}/runtime/state` |
| Session capability/action availability | snapshot `effectiveCapabilities`, local status checks, or old protocol capability projection | `GET /sessions/{sessionId}/runtime/capabilities` plus session realtime capability updates |
| Session model/permission selection update | `PATCH /sessions/{sessionId}/state/selections` | `PATCH /sessions/{sessionId}/runtime/selections` |
| Send message in an existing session | `POST /sessions/{sessionId}/messages` | `POST /sessions/{sessionId}/runtime/messages` |
| Steer running session | `POST /sessions/{sessionId}/steer` | `POST /sessions/{sessionId}/runtime/steer` |
| Interrupt session | `POST /sessions/{sessionId}/interrupt` | `POST /sessions/{sessionId}/runtime/interrupt` |
| List slash commands | `GET /sessions/{sessionId}/commands?query=...` | `GET /sessions/{sessionId}/runtime/commands` |
| Execute slash command | `POST /sessions/{sessionId}/commands` | `POST /sessions/{sessionId}/runtime/commands` |
| Read runtime notices | snapshot/DB notice fields | `GET /sessions/{sessionId}/runtime/notices` |
| Respond to runtime notice | `POST /sessions/{sessionId}/interactions/{noticeId}/respond` | `POST /sessions/{sessionId}/runtime/notices/{noticeId}/respond` |
| Mark sessions read | `POST /sessions/bulk-read` with `{ "ids": [...] }` | `POST /sessions/read` with direct JSON array |
| Archive sessions | `POST /sessions/bulk-archive` with `{ "ids": [...], "archived": true }` | `POST /sessions/archive` with direct JSON array |

## Frontend behavior changes

### Selectors

Model and permission menus should live-read catalogs when the user opens the
selector.

- New session page reads runtime-level catalogs from connector runtime paths.
- Existing session page reads current session selection from
  `/sessions/{sessionId}/runtime/state`.
- Existing session page writes selection changes through
  `/sessions/{sessionId}/runtime/selections`.
- The frontend may remember the user's most recent selection locally, but it
  must validate that selection against the latest live catalog before showing it
  as selected.
- If the remembered selection is missing or disabled, choose the first enabled
  selection from the latest catalog.

### Commands

Slash command UX should read the full session command list when entering command
mode or when the menu is opened:

```text
GET /sessions/{sessionId}/runtime/commands
```

The frontend performs fuzzy matching locally. Do not send a `query` parameter.

If command list reading fails, slash-prefixed input must stay in command mode and
show an error. It must not be silently sent as a normal message.

### Effective capability

The frontend should use effective capability updates as the primary action
contract:

- send button enabled state comes from `session.send_message`;
- interrupt button enabled state comes from `session.interrupt`;
- steer UI enabled state comes from `session.steer`;
- approval response controls come from `session.interaction.approval`;
- catalog selector availability comes from `catalog.model` and
  `catalog.permission`.

Local runtime status can be displayed, but it should not be the primary action
availability state when effective capability exists.

### Realtime

For each open session, reuse the session realtime connection for:

- timeline item upserts;
- runtime state updates;
- runtime notice updates;
- session-scoped capability updates.

Dashboard lifecycle data should use dashboard realtime APIs rather than polling
connector/session lists. Polling is acceptable only as a temporary fallback after
WebSocket disconnect or explicit user refresh.

### Snapshot usage

Snapshot is an initial hydration and recovery API. The frontend should not poll
snapshot on normal deltas.

Allowed snapshot reads:

- initial session page load;
- explicit recovery when `/events` returns `snapshotRequired`;
- manual refresh requested by the user.

Not allowed:

- periodic snapshot polling;
- refetching snapshot only because sequence numbers have gaps;
- using `snapshot.catalogs` as the model or permission source.

### Timeline rendering

The frontend timeline renderer should render all platform parent item types
directly. Runtime-specific subclasses must reduce to these parent item types
before reaching generic UI rendering.

Required parent item coverage:

- user message;
- assistant message;
- system marker;
- compaction marker, with running and done states;
- tool group;
- tool item;
- approval/interaction item;
- artifact/file item;
- error item;
- turn start/end markers.

Fallback rendering should be diagnostic and visually quiet. It should include
the unknown item type and stable id, but it should not appear for known Codex
SDK item types such as context compaction.

## Backend blockers before frontend migration

Do not remove frontend old-path calls until these backend items are complete:

1. Runtime notices are runtime-owned live reads, not DB-backed compatibility.
2. Effective capability projection no longer derives action availability from
   persisted `session.status`.
3. Session runtime state fallback no longer treats DB state as runtime truth
   except for explicit connector-offline projection.
4. Old session action endpoints are compatibility shims only, with documented
   removal comments.
5. The backend route list matches `docs/api/session-api-proposal.md`.

## Suggested frontend migration order

1. Update API client methods and types for the new runtime/session scoped paths.
2. Migrate new-session model and permission selectors to connector runtime
   catalog paths.
3. Migrate existing-session selectors to live session state and runtime
   selection updates.
4. Migrate session actions: message, steer, interrupt.
5. Migrate slash command list and execution.
6. Migrate notice list and response.
7. Replace local action-state derivation with effective capability reads and
   realtime updates.
8. Remove snapshot polling except initial load and explicit recovery.
9. Remove old API client methods once no frontend call sites remain.
