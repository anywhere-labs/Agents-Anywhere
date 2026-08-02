# Web Behavior Target

Status: draft.

This document defines how Web should consume Agent Runtime Protocol v1.

## Principles

- Web must not infer behavior from runtime names.
- Web must not maintain server catalog caches as source of truth.
- Web may remember the user's most recent model/permission selection locally for new sessions only.
- Message sending must not carry model/permission selection ids for existing sessions.
- Commands are not messages.

## New session

Flow:

```text
Open new session
  -> read runtime model catalog
  -> read runtime permission catalog
  -> preselect local recent selection if still present and enabled
  -> otherwise choose first enabled option
  -> create_and_start with selections + first message
```

There is no runtime default in the protocol. Defaulting is a frontend behavior.

Blank new session creation is not supported in the first target.

## Existing session

Initial load:

```text
Load session snapshot
  -> read SessionMeta
  -> read SessionState
  -> read SessionTimeline
  -> read SessionNotice
  -> render timeline/notices
```

Opening selectors:

```text
Open model selector
  -> live read runtime model catalog

Open permission selector
  -> live read runtime permission catalog
```

Changing selectors:

```text
User chooses selection
  -> PATCH session selection
  -> runtime accepts or rejects
  -> Web may update optimistically
  -> Web reconciles from session.state.updated event or GET /state
```

The runtime may also update selections without direct user action. Web must treat `session.state.updated` as authoritative.

## Message composer

For existing sessions:

```text
POST /sessions/{id}/messages
```

Payload should include:

- content
- attachments
- client message id

Payload must not include:

- model selection id
- permission selection id

## Commands

When the input begins with `/`, Web should list commands by live RPC:

```text
GET /sessions/{id}/commands?query=...
```

The frontend handles:

- fuzzy matching
- ranking
- keyboard navigation
- completion
- displaying disabled reason

The protocol does not include `autocomplete`.

Executing a command:

```text
POST /sessions/{id}/commands
```

Command execution returns a normal RPC result. If the runtime changes timeline, state, selection, or notices, those changes arrive through normal runtime events.

If command catalog lookup or execution fails, Web must show an error and must not send the `/xxx` input as a normal message.

## Session state UI

Web should render busy/interrupt/blocking UI from session state, timeline, and notices. `SessionState.status` is the sole source for whether the session is running/interruption-capable; timeline and notices explain what is happening but must not replace the running-state projection.

`SessionState` includes:

- status
- selections
- status reason
- error
- metadata

It does not include:

- active turn id
- command list
- catalog data
- timeline items

## Snapshot and recovery

Snapshot is for initial load and explicit recovery, not periodic refresh. Normal updates should flow through WebSocket/event recovery.

Sequence gaps should not force snapshot unless the server explicitly marks recovery as impossible. Timeline items are upsert-only; hiding replaces deletion.
