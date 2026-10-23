# Protocol 1.0 Contract

The Server Pydantic wire models are the source of truth for these artifacts.
Files under `schemas/` and `manifest.json` are generated and must not be edited
by hand.

Regenerate the contract from the repository root:

```bash
cd server
uv run python -m scripts.export_protocol_schemas
```

Regenerate or verify the Web TypeScript modules:

```bash
cd web-next
yarn protocol:generate
yarn protocol:check
```

The `fixtures/valid` and `fixtures/invalid` directories are reviewed compatibility
examples shared by the Server, Connector, and Web test suites. Extensible
capability identifiers and catalog metadata remain strings and JSON objects;
only well-known identifiers may enable product behavior.

Protocol version `1.0` is independent of the application version and database
schema revision.

## Native workspace inventory extension

`runtime.workspaces.updated` is an authenticated Connector ingestion notification,
not a client event. Its bound `runtime` / `runtimeId` identify the source. The
version 1 payload is `{version: 1, complete: true, snapshotId, observedAt,
membershipScope?: "runtime" | "tracked",
workspaces: [{id, title, path, roots?, sessionIds}]}`. IDs are native IDs, `path`
is the primary directory, and optional `roots` preserves additional native roots.
Only a successful authoritative complete read may remove memberships. An empty
inventory is not a substitute for unavailable APIs or failed reads. Duplicate
paths or members are rejected rather than merged. Limits are 10000 workspaces
and 50000 members within the existing ingestion request limit.

DSH supplies its native registry. Codex supplies experimental `project/list`
and explicit thread `projectId` assignments. Its `membershipScope: "tracked"`
limits native management to sessions ever explicitly assigned to a native
project. Other cwd-only histories retain their existing grouping, including
after the first native assignment. The default `"runtime"` scope (DSH) treats
the full runtime membership as authoritative. Removed tracked members remain
ungrouped until explicitly reassigned; their tracked identity survives restart.
Once enabled, missing APIs retain the last accepted inventory. Reconnection and
periodic scans reconcile state in addition to native change notifications.
Server persists pending application IDs separately from snapshot receipt.
Completed identical inventories skip session writes and dashboard invalidation;
partial applications remain retryable and include earlier committed changes in
the eventual notification. Newer snapshots supersede older session plans.
Membership changes preserve AA archives and history; unrelated runtimes are not
affected. Claude retains existing recent-session discovery and cwd grouping;
this extension does not add native workspace membership or complete history
reconciliation to Claude.

## Attachment MIME restrictions

`runtime.attachment` can declare an optional `metadata.allowedMimeTypes` array of
exact, lowercase MIME types. For example, DSH declares
`["image/png", "image/jpeg", "image/webp", "image/gif"]`.

- Omitted: no additional MIME restriction, preserving existing runtime behavior.
- Empty array or malformed value: no attachment type is allowed.
- Present: each attachment must match one listed type; extensions and wildcards
  such as `image/*` do not grant permission.

Desktop and Web apply the list to file picking, pasting, dropping and submission,
including files selected before switching runtimes. The Server validates the
stored upload's MIME before dispatch. Runtime adapters still validate actual
content using their native attachment interface; MIME metadata alone does not
prove that a file is a valid image. `supported`, `available` and `allowed` must
also permit `runtime.attachment`.
