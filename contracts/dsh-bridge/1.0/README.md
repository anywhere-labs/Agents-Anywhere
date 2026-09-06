# DSH Bridge Protocol 1.0

These schemas and fixtures define the line-level JSON-RPC contract shared by the
Agents Anywhere Connector and `@agents-anywhere/dsh-bridge-next` (and the legacy bridge). Transport tests own
UTF-8 framing, newline handling, and the 8 MiB frame limit.

Protocol `1.x` may add optional fields and notifications. Runtime IDs, required
fields, method semantics, error codes, and identity algorithms require a major
version when changed incompatibly.

## Read-only implementation

The Next plugin implements authenticated `initialize`, `ping`, `runtime.getConfig`,
`runtime.getCapabilities`, `session.list`, `session.getSnapshot`, `session.getState`,
`session.getNotices`, and `session.getCapabilities`. Write/catalog operations return
`UNSUPPORTED_OPERATION`; corresponding capabilities are disabled.

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
