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

Agents Anywhere deliberately does not participate in that election. It never
listens on, unlinks, or replaces the Codex IPC endpoint. At the beginning of
each normal session-sync cycle it discovers the endpoint again and connects
when a router is available. No router is a normal condition: app-server sync
continues, and a later cycle retries discovery without treating the missing
socket as a Connector failure.

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
For each conversation, the Connector can independently be:

- `owner`: it owns the app-server stream and the authoritative in-memory UI
  conversation state;
- `follower`: it ignores app-server mutations for that conversation and uses
  the owner's IPC state instead.

Router and owner are unrelated roles. The Codex App may be the router while the
Connector is the owner of one conversation and a follower of another.

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

The integration should preserve the existing app-server adapter boundary while
also publishing locally owned app-server state to IPC:

```text
Codex app-server JSON-RPC ----> TimelineReducer ----> backend notifications
            |                     ^
            v                     |
     local IPC publisher     remote IPC mirror
            |                     ^
            +------ IPC router ---+
```

The IPC layer should not post to Server directly and should not introduce a
second timeline model. Remote IPC state is normalized into the existing
`TimelineReducer`. Local app-server state is projected into the Codex canonical
conversation shape and published to IPC for IDE/App followers.

Recommended implementation sequence:

1. Add a reconnecting `CodexIpcClient` that handles endpoint discovery,
   length-prefixed framing, initialization, broadcasts, and shutdown. It must
   never create or remove the endpoint.
2. At the beginning of every `sync_existing_sessions` cycle, verify the IPC
   connection. Connect and initialize if a router has appeared; reconnect and
   restore subscriptions if the prior router disappeared.
3. Add a state registry keyed by Codex `conversationId` with role, owner id,
   revision, canonical state, followers, and followed/unfollowed status.
4. During `sync_existing_sessions`, bind every discovered Codex thread to its
   stable Agents Anywhere session id, including threads skipped by the normal
   fingerprint optimization, then follow that thread over IPC.
5. On a remote IPC snapshot, flatten canonical history in island order and call
   `TimelineReducer.reduce_thread_snapshot`. Emit `session.updated` plus one
   authoritative `timeline.sync`.
6. On a valid remote patch batch, identify affected turn entities and item
   indexes. Feed only changed items into a new reducer entry point and emit
   `timeline.itemUpsert`; do not resend a complete turn for every token.
7. When a remote turn status changes, reuse the reducer's existing turn
   start/end and session status mapping. When title/cwd changes, emit
   `session.updated`.
8. Project local app-server snapshots and events into the same canonical state.
   When another IPC client follows a locally owned conversation, send it a
   targeted snapshot and then targeted patches in revision order.
9. Tag every update with its source. Never republish a remote IPC update back to
   IPC. Deduplicate backend notifications by the existing stable timeline id
   and content hash.
10. On disconnect, owner change, schema/version mismatch, or revision gap, stop
   incremental emission and request a new snapshot. The existing periodic
   app-server sync remains the fallback source of final state.

## Publishing local app-server state

The Connector's app-server is authoritative for threads it creates or actively
drives locally. Merely loading or resuming a thread for synchronization does
not claim ownership. Locally owned threads must be visible to Codex IDE/App
clients through the IPC router even though the Connector is not the router.

The outbound flow is:

1. Build canonical conversation state from `thread/read` during the normal
   sync and retain it as inactive state.
2. Observe `thread-stream-following-changed` broadcasts. For `following=true`,
   register the follower's `sourceClientId` and immediately send that client a
   targeted version-11 snapshot at the current revision. For `following=false`,
   remove it.
3. After explicit local ownership, reduce each app-server notification into
   both the existing backend timeline event and retained canonical IPC state.
4. Generate `add`, `replace`, or `remove` patches from the previous canonical
   state, increment the revision by exactly one, and target the current follower
   client ids.
5. If an app-server event cannot be represented safely as a patch, advance by
   sending a fresh targeted snapshot instead of emitting a guessed patch.

This is state replication, not raw event forwarding. App-server notification
names and payloads are not valid IPC methods, so they must first update the
canonical state. This also gives late followers a complete snapshot and keeps
token text replacement semantics consistent with Codex App and IDE.

The Connector keeps state loaded by ordinary sync inactive until it creates the
thread or explicitly starts a turn. Notifications caused by passive
`thread/resume` and `thread/read` operations never claim ownership. This is
essential because the Connector's separate app-server can emit notifications
for a thread currently owned by Codex App. Activation explicitly sends
`following=false`, discards any remote mirror for that conversation, and sends
a snapshot to waiting followers.

The local projector currently emits incremental patches for thread names, turn
start/completion, item start/completion, agent-message text, command output,
and turn diffs. Agent-message and command-output deltas are accumulated into
full-field replacements. For an already owned thread, an event that is not
safely projectable schedules an asynchronous `thread/read`; the refreshed
canonical state is then sent as a new snapshot if it changed.
The refresh runs outside the app-server notification callback so JSON-RPC
responses are not blocked behind that callback.

## Control requests

The same router supports `thread-follower-*` requests for start, steer,
interrupt, settings, approvals, user input, and history loading. Request
handling is owner-aware: a candidate reports `canHandle=true` only when its
conversation role is `owner`.

Steer is the first integrated control request. The Connector accepts
`thread-follower-steer-turn` only when its locally owned canonical state has an
active turn. It derives `expectedTurnId` from that state and calls app-server
`turn/steer`; ownership alone is insufficient because a completed turn cannot
be steered.

When Agents Anywhere is the follower, it materializes attachments, targets the
owner recorded by the current IPC snapshot, and sends the same version-1
request through the discovered router. The owner response is returned through
the normal `turn.steer` Connector RPC. If no remote owner is known, the adapter
falls back to its local app-server. Start, interrupt, settings, and approval
control requests are not yet routed through IPC.

## Compatibility boundary

The internal protocol can change with a Codex release. Compatibility is based
on the method version, not the Codex binary version:

- ignore an unknown broadcast method;
- reject a known method with a mismatched version;
- preserve additive unknown fields in conversation state;
- never attempt best-effort application after a revision gap;
- retain app-server history sync as the correctness fallback.
