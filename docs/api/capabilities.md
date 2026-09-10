# Effective Capability API

Status: authoritative proposal for capability semantics in the next breaking API cleanup.

Agents Anywhere exposes effective capabilities to Web clients. Raw runtime
capabilities, runtime state, connector presence, user authorization, takeover,
and Server policy are internal inputs. Web should not run its own state machine
to decide whether an action is possible.

## Scopes

There are two effective capability scopes.

### Runtime-scoped effective capability

Runtime-scoped capability describes what a connector runtime can do outside a
specific session.

Examples:

```text
runtime.config
runtime.session.create
runtime.session.discover
runtime.catalog.model
runtime.catalog.permission
runtime.command.list
runtime.ipc
runtime.attachment
```

Runtime-scoped capabilities affect dashboard/setup/create behavior, runtime
configuration UI, global runtime catalogs before a session exists, and feature
entry points such as IPC controls.

### Session-scoped effective capability

Session-scoped capability describes what is possible for one active session
right now.

Examples:

```text
session.send_message
session.steer
session.interrupt
session.selection.update
session.command.execute
session.interaction.approval.respond
session.catalog.model
session.catalog.permission
```

Session-scoped capability is RuntimeLive. It can change while a turn is running,
while a command is executing, while the runtime is compacting context, or after
the runtime notices that an active turn no longer exists.

## Capability shape

The wire shape should stay simple and flat:

```json
{
  "capabilityId": "session.interrupt",
  "scope": "session",
  "runtime": "codex",
  "connectorId": "conn_...",
  "sessionId": "sess_...",
  "supported": true,
  "available": false,
  "allowed": true,
  "unavailableReason": "runtime_no_active_turn",
  "metadata": {}
}
```

Capability set:

```json
{
  "scope": "session",
  "runtime": "codex",
  "connectorId": "conn_...",
  "sessionId": "sess_...",
  "revision": 42,
  "capabilities": []
}
```

Field semantics:

- `supported=false`: the runtime or connector implementation does not support
  this capability at all.
- `available=false`: the capability exists but cannot be used now. This is
  usually runtime-owned live state, for example no active turn, compact in
  progress, command already running, or runtime process unavailable.
- `allowed=false`: the capability exists and may be technically available, but
  platform policy, user authorization, takeover, or connector ownership does
  not allow this user to use it.
- `unavailableReason` is a stable machine-readable code. UI may map it to
  localized text, but should not rely on free-form messages.
- `revision` orders capability-set updates for one scope. Clients ignore older
  revisions.

## Ownership

Runtime owns runtime facts:

```text
currently running
currently waiting
active turn exists
interrupt handle exists
steer accepted now
compact in progress
selection can be changed now
command can execute now
```

Server owns platform policy:

```text
connector online/offline projection
runtime reachable/unreachable projection
user authorization
session ownership
takeover
server feature policy
```

Server must not infer runtime-owned capability from:

```text
sessions.status
timeline active items
open notices
session_active_runs
historical compact/tool/approval items
```

Web owns presentation only:

```text
render enabled/disabled state from effective capability
show status labels from RuntimeLive state
show timeline from SessionTimeline
call live read endpoints when a capability set is missing or stale
```

Web must not decide action availability from a local status state machine when
an effective capability exists for that action.

## Pull API

All routes are mounted under `/api/v2`.

Runtime-scoped capabilities live under runtime resources:

```text
GET /runtimes/{runtime}/capabilities
GET /runtimes/{runtime}/catalogs/model
GET /runtimes/{runtime}/catalogs/permission
GET /runtimes/{runtime}/commands
```

If a connector must be selected because multiple local connectors expose the
same runtime, encode that connector in the path rather than a query parameter:

```text
GET /connectors/{connectorId}/runtimes/{runtime}/capabilities
GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/model
GET /connectors/{connectorId}/runtimes/{runtime}/catalogs/permission
GET /connectors/{connectorId}/runtimes/{runtime}/commands
```

Session-scoped capabilities live under session runtime resources:

```text
GET /sessions/{sessionId}/runtime/capabilities
GET /sessions/{sessionId}/runtime/catalogs/model
GET /sessions/{sessionId}/runtime/catalogs/permission
GET /sessions/{sessionId}/runtime/commands
```

Command endpoints return the current command list. Web performs fuzzy matching
and filtering locally after reading the list.

Do not add new APIs like:

```text
GET /agents/{runtime}/model-catalog?connectorId=conn_...
GET /connectors/{connectorId}/protocol/capabilities
```

Those legacy routes are removed from the target API. If old agent catalog query
routes or connector protocol capability reads still exist in a migration build,
they should return an explicit migration error. They must not start runtimes,
perform connector RPC, or serve UI capability facts. Other temporary shims
should point callers to the scoped runtime or session endpoints above.

## Push API

Dashboard/runtime lifecycle:

```text
runtime.capability.updated
```

Session lifecycle:

```text
runtime.capability.updated
```

The event name can be the same because the WebSocket scope is different. A
dashboard or runtime socket receives runtime-scoped capability sets. A session
socket receives session-scoped capability sets.

Session-scoped runtime actions should normally trigger capability updates when
their availability changes. Examples:

```text
turn starts       -> session.send_message false, session.interrupt true
turn finishes     -> session.send_message true, session.interrupt false
compact starts    -> session.send_message false, session.command.execute false
compact finishes  -> session.send_message true, session.command.execute true
no active turn    -> session.interrupt false
takeover changes  -> allowed changes on session actions
```

## Relationship to runtime state

Runtime state remains useful for display:

```text
idle
waiting
running
blocked
error
disconnected
```

Capability is the source for actions.

For example, Web may render "Codex is working" from `runtime.state.updated`, but
the interrupt button is shown only when `session.interrupt` is effective.

## Migration notes

Existing `ProtocolCapabilitySet` fields can be reused during migration, but the
source of truth changes:

- `effectiveCapabilities` remains in session snapshots as a transitional HTTP
  aggregate field. Session realtime updates use
  `runtime.capability.updated.payload.capabilitySet`.
- `protocol.capabilitiesUpdated` is compatibility connector input.
- `connector_protocol_capabilities` must not be used as authoritative UI truth.
- Removed connector protocol capability reads migrate to scoped effective
  capability endpoints.
- Removed agent catalog reads with `connectorId` query params migrate to
  connector runtime catalog paths.
- Removed command query endpoints migrate to full command-list reads plus Web
  local fuzzy matching.

The target client reads effective capabilities from scoped live endpoints and
listens for scoped `runtime.capability.updated` events.
