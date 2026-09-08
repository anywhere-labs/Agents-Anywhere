# DSH Bridge Protocol 1.0

These schemas and fixtures define the line-level JSON-RPC contract shared by the
Agents Anywhere Connector and `@agents-anywhere/dsh-bridge-next` (and the legacy bridge). Transport tests own
UTF-8 framing, newline handling, and the 8 MiB frame limit.

Protocol `1.x` may add optional fields and notifications. Runtime IDs, required
fields, method semantics, error codes, and identity algorithms require a major
version when changed incompatibly.

## Next implementation

The Next plugin implements authenticated `initialize`, `ping`, `runtime.getConfig`,
`runtime.getCapabilities`, `session.list`, `session.getSnapshot`, `session.getState`,
`session.getNotices`, and `session.getCapabilities`. With the native Agent service,
`session.createAndStart`, `session.startTurn` and `session.interrupt` are enabled.
Sends require a stable `clientMessageId`. `session.respondInteraction` handles
native `ask_user_question` requests via the existing platform inputRequest v1 form.
AA image sends are available when the official Session Controller and attachment
store are mounted. Native model and preset selection stay in the Host.
Permission approval and plan-review responses remain unsupported.

`initialize.params.sessionNamespace` is optional and defaults to `connectorId`.
The Connector sends its RuntimeHost `session_namespace` so the plugin can produce
canonical platform session IDs directly. This retains the existing hash algorithm.
Feature flags add `readOnly` and `snapshotPagination`; these are optional 1.x fields.

The canonical Timeline schema already defines `type/status/content/source/contentHash`.
Legacy native `payload` envelopes are not part of that schema and are no longer
projected by Python. The plugin is the sole native-log projection owner.

## AA image sends (additive 1.x)

`runtime.attachment.metadata.allowedMimeTypes` is exactly
`["image/png", "image/jpeg", "image/webp", "image/gif"]`, matching official
`ctx.attachments.saveImages()` input types. PDF, SVG, AVIF and other file formats
are rejected. The selected DSH model must also support image input.

`session.createAndStart` and `session.startTurn` accept optional `attachments`:

```json
{
  "attachments": [{
    "uploadId": "a11ce000000000000000000000000001",
    "fileId": "file_example",
    "name": "example.png",
    "mediaType": "image/png",
    "size": 70,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }]
}
```

The size and checksum above are illustrative; both must match the staged bytes.
`content` may be empty when images are present. The Connector downloads AA files
through its existing authenticated attachment API and stages the complete batch
under `<endpoint directory>/attachments/staging/<uploadId>`. `uploadId` is a
random 32-character lowercase hex value, never a caller-supplied path. File bytes
and Base64 are not included in Bridge frames, so the 8 MiB RPC limit is unchanged.
The Connector removes temporary files when the request succeeds or fails.

The Host verifies IDs, MIME, size, checksum and staging location, then calls
official `SessionController.prompt`. Its admission path invokes `saveImages()`
to validate/normalize the entire batch before enqueueing a message. Official
image count and byte limits remain authoritative. A failed attachment is never
silently dropped to send only the text or remaining images.

AA file references are recorded at `<endpoint directory>/attachments/receipts`,
keyed by native session and message identity. Live projection and history reads
use the same receipt, so AA attachments survive refresh and Host restart.
Retries ignore transient upload IDs and do not enqueue a second message, even
after staging cleanup. A receipt belongs only to its platform session namespace.
DSH owns normalized image objects; native images without an AA receipt retain
their existing native-reference placeholder and are not copied into AA storage.

## Pagination

`session.list` accepts `limit` (1–1000, default 100) and optional `cursor`; it returns
`sessions` and nullable `nextCursor`. Cursors page through a captured inventory,
so newly arriving sessions cannot shift pages within an inventory scan.

`session.getSnapshot` accepts the usual session identity, optional total `limit`,
and optional `cursor`. Additive response fields are:

- `nextCursor`: continue reading the same captured timeline, or null.
- `snapshotComplete`: whether the whole capture covers the original timeline.
- `watermark`: the native last sequence and projection revision, stable across pages.
- `metadata.totalItems`: item count in this capture, after an explicit limit.

Each response contains at most 1000 items and under 7 MiB of item data. A single
oversized item fails with `FRAME_TOO_LARGE`. An individual partial page has
`complete=false`; the Connector assembles and validates every page before declaring
a full snapshot complete. Applying an explicit truncating limit always leaves the
assembled snapshot incomplete. Cursors expire after 120 seconds and never survive
reconnection. Unknown, mismatched, repeated, or expired cursors fail explicitly.

Protocol identity/hash fixtures are verified in both languages. The native SDK
composition test also reads persisted sessions through the real Python adapter.

## Event subscription (additive 1.x)

The handshake advertises `features.syncMode = events` and `projectionVersion = 2`.
`runtime.sync.subscribe` replaces this connection's previous subscription and returns
`streamId` plus the projection version. `runtime.sync.batch` notifications follow
`sync-batch.schema.json`, with monotonic `batchSeq`. The Connector acknowledges each
batch via `runtime.sync.ack {streamId,batchSeq}` before the next batch is sent.

`snapshot.begin/items/commit` captures one visible session. Pages are staged only
in the Connector; after count and identity checks it forwards existing backend
`session.meta.upsert` and `timeline.sync {complete:true}` notifications. Abort or
incomplete transport never submits a partial replacement. Turn lifecycle markers
are excluded from backend Timeline contents.

`notifications` carries already normalized platform notifications. The Connector
forwards live Timeline, state, source and metadata updates through the same typed
Host publishers used by Codex and Claude. These bind the immutable runtime
instance and use the existing coalescing, WebSocket sender and HTTP fallback
queue. Complete snapshots and inventory boundaries continue to await
`/connector/ingest`. No public transport implementation or backend API changes.
An ACK means page receipt, acceptance by the existing live notification pipeline
(including its queues), or completed snapshot ingestion; it is not a durable
server persistence ACK. Relay failures replace only the sync subscription on the
existing RPC connection; incomplete captures are discarded before full native
history recalibration. Socket failure still uses endpoint rediscovery and reconnect.

The private batch also carries the existing `notice.upsert` and
`runtime.capability.updated` notifications. The DSH adapter forwards these through
the existing RuntimeHost notice/capability publishers, without extending the
platform protocol. Question ACK means handoff to those publishers; reconnect and
`session.getNotices` reconcile current pending state from the official Gateway.

`runtime.sync.refresh` takes a session identity and requests its complete baseline;
`runtime.sync.unsubscribe` stops delivery. Event runtimes bypass periodic history
scanning. History and live events share stable item identities and ordering.

## Error isolation and recovery

Each request has its own cancellation and a 60-second Host deadline. Parse,
validation, native service and response-size errors return a structured error;
they do not abort concurrent requests or close an authenticated connection.
Late results from cancelled requests do not send another response. Unknown
exceptions use `INTERNAL_ERROR`, without exposing native exception text.
Authentication failure, socket failure and transport backpressure remain scoped
to that connection; other connections and the listener continue serving.

A session read, projection, attachment receipt or configuration failure affects
only that session's sync. Open snapshots are aborted, previously accepted AA
history is retained, and an explicit refresh or later native activity can retry.
Failed model catalog reads do not disable messaging. Provider/catalog changes
and explicit reads can retry the failed directory.

Whole-inventory or stream failures send `runtime.error` with additive
`data.scope = "sync"` and `data.streamId`. The Connector resubscribes after a
bounded delay without cancelling other RPC requests; a late error from an old
stream is ignored. Missing ACKs fail the stream after 60 seconds. Both sides must
load this implementation for recovery without closing the RPC connection.

`workspace.list` remains a read-only native query. The plugin does not publish
workspace inventories or native project names. The relay ignores legacy
`workspace.inventory` operations without storing or forwarding them. The unchanged
backend groups sessions by cwd and derives project names from its final segment,
using the same path as other runtimes.

The official sidebar filter is applied before import and on every read/send path.
Never-imported hidden sessions produce no history rows. Explicit native archives
use the existing source notification with `availability: "archived"`; blank or
filtered sessions use `unavailable`. Complete inventories carry these source facts.
`session.getState` freshly reads the official catalog and returns `sourceState`;
the adapter forwards that fact through existing ingestion before returning state.
Sends recheck availability and return
`{ok:false,code:"session_archived",result:{sourceState,...}}` for archived sessions.
No server logic, tables, migrations, or additional AA unarchive protection are added.
