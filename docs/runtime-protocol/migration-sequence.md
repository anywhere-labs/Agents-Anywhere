# Migration Sequence

Status: draft.

This refactor is breaking. Prefer independently verifiable commits. Do not combine the protocol skeleton, database migration, Codex adapter rewrite, and Web rewrite into one change.

## 1. Documentation and deprecation markers

- Add this `docs/runtime-protocol/` directory.
- Mark older v2 plan/migration docs as superseded where they conflict.

## 2. Connector protocol skeleton

Add new connector modules without changing behavior:

```text
connector/connector/runtime/
  protocol.py
  host.py
  models.py
  errors.py
```

Define:

- `AgentRuntime`
- `RuntimeHostClient`
- dataclass models
- standard errors

Add tests for:

- default unsupported behavior
- no keyword-only `*` in public ABC method signatures
- selection id helper compatibility
- host client fake recording

Do not combine this with large file moves. The target Connector tree is
documented in [Connector structure target](./connector-structure.md).

## 3. Connector application host client

Implement a host client adapter that maps runtime host calls to current server notifications:

```text
RuntimeHostClient -> current ingest notifications
```

This stage should replace direct adapter dependencies on:

- `notification_sink`
- `attachment_downloader`
- `sync_state_store`
- `backendNotifications`

## 4. Server database projections

Add durable projections:

- `session_states`

Add repository/service APIs for upsert/read.

Keep existing session status compatibility only as a transitional projection if needed.

## 5. Server API and ingest

Add or replace APIs:

- live runtime model catalog
- live runtime permission catalog
- session state read
- session selection update through SessionState
- command list/execute
- create-and-start session

Add ingest handlers for:

- `session.state.updated`

## 6. Codex runtime adapter

Refactor Codex to implement `AgentRuntime` and use `RuntimeHostClient`.

Codex internals remain internal:

- app-server stdio
- IPC
- history
- reducer
- sync state

The adapter should expose only protocol behavior upward.

## 7. Claude runtime adapter

Refactor Claude to implement `AgentRuntime` and use `RuntimeHostClient`.

Claude may implement a smaller feature subset. Unsupported behavior must be explicit.

## 8. Web protocol-driven UI

Update Web:

- read model/permission catalogs on selector open
- read SessionMeta/SessionState/SessionTimeline/SessionNotice on session load
- update selection before message send
- remove model/permission from message send payload
- list commands with live RPC on `/`
- remove frontend-built command list
- use session state projection for busy/interrupt rendering

## 9. Remove old protocol paths

Remove or fully deprecate:

- server-persisted catalog primary read path
- selection fields on session/message/create payloads
- old command endpoint behavior that hardcodes commands
- connector adapter `backendNotifications`

## Acceptance

Before accepting the migration:

- existing session sends messages without selection fields
- model/permission selectors read live runtime catalogs
- session selections survive refresh through persisted SessionState
- runtime running/waiting/blocked/error/disconnected state survives refresh through persisted SessionState
- command list is runtime-driven and fuzzy-matched by frontend
- command execution does not create a user message
- Codex IPC state updates map to SessionState/SessionTimeline/SessionNotice projections without leaking IPC methods upward
