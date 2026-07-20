# Session Snapshot v2 migration

This slice adds a session-level snapshot endpoint for the session detail page.

Compatibility with pre-v2 clients is not required. New clients should use the snapshot shape directly and avoid recomputing feature availability from runtime names or raw session state.

## Endpoint

```text
GET /api/v2/sessions/{sessionId}/snapshot
```

Query:

```text
limit=200
```

Response:

```json
{
  "session": {},
  "timeline": {
    "items": [],
    "nextSeq": 42,
    "hasMore": false
  },
  "approvals": [],
  "effectiveCapabilities": {
    "revision": 42,
    "capabilities": []
  },
  "runtimeCapabilities": {
    "revision": 3,
    "capabilities": []
  },
  "eventCursor": "seq:42",
  "serverTime": "2026-07-20T10:00:00Z"
}
```

`approvals` is still the legacy approval projection for this slice. Notice / Interaction will replace it in a later migration.

`eventCursor` is currently derived from the session timeline sequence. The future WebSocket event stream can replace this with a dedicated protocol event cursor without changing the page startup model.

## Effective capabilities

`effectiveCapabilities` is session-scoped and intended for direct UI gating.

The server derives it from:

- connector-published runtime capabilities;
- session status;
- connector effective online status;
- server-side authorization.

Current rules:

- `session.send_message`
  - available when connector is online and session status is `idle`
- `session.interrupt`
  - inherited from runtime `session.interrupt`
  - available when connector is online and session status is `running` or `waiting_approval`
- `session.steer`
  - inherited from runtime `session.steer`
  - available when connector is online and session status is `running`
- `session.interaction.approval`, `runtime.config`, `catalog.model`, `catalog.permission`, `catalog.effort`
  - inherited from matching runtime capability and connector online status

The snapshot uses `scope: "session"` and includes `sessionId` on every effective capability, even when the capability is inherited from a runtime-level capability.

## Web migration analysis

Session detail should start from:

```text
GET /api/v2/sessions/{sessionId}/snapshot
```

Instead of independently fetching:

- `/sessions/{id}/state`
- `/connectors/{id}/protocol/capabilities`
- pending approvals
- separate first-page timeline state

Recommended first Web integration:

1. Add a `getSessionSnapshot(sessionId, { limit })` API method.
2. Add `SessionSnapshot`, `ProtocolCapability`, and `ProtocolCapabilitySet` types.
3. Replace the session detail initial state load with snapshot.
4. Keep the old SSE/state update path temporarily only as an implementation detail while the client WebSocket slice is not done.
5. Gate UI from `effectiveCapabilities`:
   - composer input: `session.send_message`
   - running composer steer mode: `session.steer`
   - stop button: `session.interrupt`
   - model picker: `catalog.model`
   - permission picker: `catalog.permission`
   - effort picker: `catalog.effort`
   - runtime settings entry: `runtime.config`
6. Do not recompute these rules in Web. Web should only interpret:
   - `supported`
   - `available`
   - `allowed`
   - `unavailableReason`

When the client WebSocket migration lands, the startup sequence should become:

```text
1. Open session WebSocket and buffer events
2. Fetch session snapshot
3. Render snapshot
4. Drop buffered events older than eventCursor
5. Apply newer events incrementally
```

For now, the endpoint is useful even without the new WebSocket stream because it makes initial page rendering capability-driven.
