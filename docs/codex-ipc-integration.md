# Codex IPC integration

## Status and source

This document describes an internal Codex IPC contract recovered from the
installed Codex IDE extension version `26.721.41059`. It is not a documented
OpenAI public API. The Connector must therefore isolate this contract behind
Pydantic validation and method-version checks.

The corresponding models live in
`connector/connector/codex/ipc_protocol.py`.

## Transport and router

On macOS and Linux the primary endpoint is:

```text
$CODEX_HOME/ipc/ipc.sock
```

`CODEX_HOME` defaults to `~/.codex`. Windows uses the named pipe
`\\.\pipe\codex-ipc`, which is outside the first Unix-socket implementation.

The wire format is not JSONL and is not JSON-RPC 2.0. Each message is:

```text
uint32_le payload_length
UTF-8 JSON payload
```

The recovered maximum JSON payload size is 256 MiB. The IPC directory is mode
`0700`, the Unix socket is mode `0600`, and Codex checks ownership before
removing or reusing a stale socket.

Every Codex surface embeds the same router election logic. The first process
that cannot connect to a live endpoint creates the Unix server and becomes the
router. Later IDE/App processes connect as ordinary clients. This is why it is
incorrect to model the topology as two processes both binding the same path.

The router has no conversation logic. It only:

1. registers clients through the `initialize` request;
2. fans broadcasts out to every other client or selected `targetClientIds`;
3. discovers a request handler by sending `client-discovery-request`;
4. forwards the request to the first client that reports `canHandle=true`;
5. correlates the response and enforces a timeout.

## Initialization

A new connection sends a version-0 `initialize` request with
`sourceClientId="initializing-client"` and a `clientType`. The router assigns a
random `clientId`. That id is used as `sourceClientId` for later broadcasts and
requests.

Client connection changes are announced with `client-status-changed`. Socket
loss invalidates the assigned id. On reconnect the client initializes again
and must restore all conversation subscriptions.

## Owner and follower flow

IPC synchronizes a Codex UI conversation, not raw app-server JSON-RPC events.
For each conversation, a surface can be:

- `owner`: it owns the app-server stream and the authoritative in-memory UI
  conversation state;
- `follower`: it ignores app-server mutations for that conversation and uses
  the owner's IPC state instead.

The follower announces:

```json
{
  "method": "thread-stream-following-changed",
  "version": 1,
  "params": {
    "conversationId": "<codex-thread-id>",
    "hostId": "local",
    "following": true
  }
}
```

The owner records the follower's `sourceClientId` and sends a targeted
`thread-stream-state-changed` version-11 snapshot. A repeated `following=true`
is significant: the owner sends another snapshot even when the follower was
already registered. The Connector can use that behavior to recover from a
revision gap.

## Snapshot and patches

The first state message contains:

```text
snapshot(revision, conversationState)
```

Newer Codex builds store turns in canonical history:

```text
conversationState
  turnHistory.kind = "canonical"
  turnHistory.history.islands[].entries[] -> entity key
  turnHistory.history.entitiesByKey[key] -> turn
  turn.items[] -> userMessage, agentMessage, reasoning, tool items, ...
```

The empty top-level `turns` array is not evidence that the conversation has no
turns. Consumers must follow island entry order and resolve each entry through
`entitiesByKey`.

Subsequent changes contain Immer patches:

```text
patches(baseRevision=N, revision=N+1, patches=[...])
```

Supported patch operations are `add`, `replace`, and `remove`; paths are arrays
of string keys and integer array indexes. During token streaming Codex normally
replaces the full `agentMessage.text` value on each revision. It does not send
an append-only token delta over IPC. Token-level synchronization means applying
these rapid full-text replacements in revision order.

A follower accepts patches only when all of these hold:

1. the conversation is currently followed;
2. `sourceClientId` is the current owner;
3. `baseRevision` equals the locally applied revision;
4. `revision == baseRevision + 1`;
5. every patch applies successfully to the current snapshot.

On any failure the mirror is no longer authoritative. It must stop emitting
derived timeline changes and repeat `following=true` to request a fresh
snapshot. Silently skipping a patch would corrupt all later path operations.

## Integration with CodexAdapter

The integration should preserve the existing app-server adapter boundary:

```text
Codex app-server JSON-RPC ----> TimelineReducer ----> backend notifications
                                  ^
Codex IPC state mirror ----------|
```

The IPC layer should not post to Server directly and should not introduce a
second timeline model. It should validate and mirror Codex conversation state,
then feed normalized turn/item snapshots into the existing `TimelineReducer`.

Recommended implementation sequence:

1. Add a reconnecting `CodexIpcClient` that handles endpoint security,
   length-prefixed framing, initialization, broadcasts, and shutdown.
2. Add a state mirror keyed by Codex `conversationId` with owner id, revision,
   canonical state, and followed/unfollowed status.
3. During `sync_existing_sessions`, bind every discovered Codex thread to its
   stable Agents Anywhere session id, including threads skipped by the normal
   fingerprint optimization, then follow that thread over IPC.
4. On an IPC snapshot, flatten canonical history in island order and call
   `TimelineReducer.reduce_thread_snapshot`. Emit `session.updated` plus one
   authoritative `timeline.sync`.
5. On a valid patch batch, identify affected turn entities and item indexes.
   Feed only changed items into a new reducer entry point and emit
   `timeline.itemUpsert`; do not resend a complete turn for every token.
6. When a turn status changes, reuse the reducer's existing turn start/end and
   session status mapping. When title/cwd changes, emit `session.updated`.
7. Deduplicate IPC updates against notifications received from the Connector's
   own app-server by the existing stable timeline id and content hash.
8. On disconnect, owner change, schema/version mismatch, or revision gap, stop
   incremental emission and request a new snapshot. The existing periodic
   app-server sync remains the fallback source of final state.

## Control requests

The same router supports `thread-follower-*` requests for start, steer,
interrupt, settings, approvals, user input, and history loading. Request
handling is owner-aware: a candidate reports `canHandle=true` only when its
conversation role is `owner`.

Those requests should be integrated after state replication. At that point
`CodexAdapter.start_turn`, `interrupt_turn`, and approval resolution can route
to the IPC owner when one exists and fall back to their current app-server RPC
when it does not. Mixing this control routing into the first state-mirror
change would make failures difficult to isolate.

## Compatibility boundary

The internal protocol can change with a Codex release. Compatibility is based
on the method version, not the Codex binary version:

- ignore an unknown broadcast method;
- reject a known method with a mismatched version;
- preserve additive unknown fields in conversation state;
- never attempt best-effort application after a revision gap;
- retain app-server history sync as the correctness fallback.
