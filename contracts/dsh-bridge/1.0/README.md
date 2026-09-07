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
Text sends require a stable `clientMessageId`; attachments and catalog/interaction
operations remain unsupported. Native model and preset selection stay in the Host.

`initialize.params.sessionNamespace` is optional and defaults to `connectorId`.
The Connector sends its RuntimeHost `session_namespace` so the plugin can produce
canonical platform session IDs directly. This retains the existing hash algorithm.
Feature flags add `readOnly` and `snapshotPagination`; these are optional 1.x fields.

The canonical Timeline schema already defines `type/status/content/source/contentHash`.
Legacy native `payload` envelopes are not part of that schema and are no longer
projected by Python. The plugin is the sole native-log projection owner.

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
binds its immutable runtime instance and awaits the existing `/connector/ingest`
path. It does not parse native events or add a backend persistence API. An ACK means
page receipt or acceptance by existing ingest, not a new durable DB transaction.
Failed/ambiguous ingest closes the stream and triggers full recalibration.

`runtime.sync.refresh` takes a session identity and requests its complete baseline;
`runtime.sync.unsubscribe` stops delivery. Event runtimes bypass periodic history
scanning. History and live events share stable item identities and ordering.

`workspace.list` returns native `{id,title,path,sessionIds}` facts. Workspace events
also send `workspace.inventory` for Connector-local state. The existing backend
continues grouping sessions by cwd; this does not add native project name writes.

The official sidebar filter is applied before import and on every read/send path.
Never-imported hidden sessions produce no rows. Previously imported sessions that
become hidden use the existing source visibility notification; their database rows
are retained according to current backend behavior.
