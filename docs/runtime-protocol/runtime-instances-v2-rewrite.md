# Runtime Instances v2 Rewrite

Status: implementation plan for `codex/runtime-instances-v2`.

This plan replaces direct integration of `codex/runtime-instances`. The old
branch remains a behavior reference, but its commits must not be merged or
rebased onto `v2`. Current `v2` has since added DSH, runtime config deletion,
session source-state tracking, inventory metadata, and later database
migrations that the old branch does not understand.

## Product decision

Named runtime instances remain a target capability.

- A runtime type describes a provider integration such as Codex, Claude, or
  DSH.
- A runtime instance is one user-configured use of that type.
- A session binds to an immutable runtime instance ID.
- Providers may restrict how many instances can be configured or active when
  their native source cannot be isolated safely.

The rewrite must preserve all behavior already present on `v2`. In
particular, it must not regress DSH source visibility, config deletion,
persisted startup errors, runtime catalog revisions, attachments, or current
Web and Android session controls.

Configuration deletion stops the instance, settles its live sessions, clears
config, active state, and persisted error, but retains the immutable instance
ID, name, and historical sessions. Hard instance deletion is out of scope for
this rewrite.

## Current v2 facts

The implementation starts from `origin/v2` at `1bf6804` or a newer fetched
tip.

- `device_runtimes` currently combines discovery facts and configured runtime
  state.
- The current Connector supervisor registers one runtime per provider.
- DSH identifies its public runtime as `dsh`, while its existing
  `runtime_type` value is the category `local-service`.
- Server DSH source-state behavior contains queries and branches that compare
  `sessions.runtime` directly with `dsh`.
- Schema revisions `v2_11`, `v2_12`, and `v2_13` are already occupied.
- Runtime config revisions already use `updatedAt` milliseconds. The
  safe-integer fix from the old branch is therefore not a separate port.
- Web already renders persisted runtime errors and supports deleting runtime
  configuration. Those behaviors must be retained rather than reintroduced
  from stale components.

## Target identity model

### Runtime type

`RuntimeTypeDescriptor` owns provider facts:

- `runtimeType`: stable provider key (`codex`, `claude`, `dsh`, ...)
- display name and description
- discovery availability and reason
- recommendation order
- configuration schema, UI schema, and defaults
- capabilities and metadata
- instance policy or maximum supported instance count

Provider category or transport values such as `local-service` belong in a
separate field or metadata. They must not be reused as the provider key.

### Runtime instance

`RuntimeInstance` owns user state:

- immutable `runtimeId`
- `runtimeType`
- editable name
- config, active flag, lifecycle status, and persisted error
- created and updated timestamps

Existing configured runtimes retain their current IDs during migration so
existing session bindings remain valid. Newly created instances use `rti_*`
IDs.

### Session binding

Sessions persist both without changing the meaning of the existing column:

- `sessions.runtime`: stable runtime type (`codex`, `claude`, `dsh`, ...)
- `sessions.runtime_id`: concrete runtime instance ID

The type snapshot is required because DSH-specific source-state behavior
cannot infer provider type from a dynamic `rti_*` ID, and a session may outlive
runtime configuration changes. Existing APIs may expose `runtimeType` as an
alias for `sessions.runtime`; they must not reinterpret `runtime` as an
instance ID.

## Runtime-control contract and rollout

Freeze `contracts/protocol/1.0`. Named-instance lifecycle belongs in a separate
`contracts/runtime-control/2.0` contract because its RPC shape and identity
semantics are incompatible with the current runtime-control surface.

Backward-compatible public API fields may be introduced additively, but the
generated `contracts/protocol/1.0` artifacts remain immutable. Any regenerated
public session/catalog contract carrying required instance identity must be
published as Protocol `1.1`, not written over `1.0`.

The runtime-control contract must carry both instance and type identity where
the Server cannot derive them safely.

```text
runtime.discover
  <- supportedControlVersions: ["2.0", "1.0"]
  -> selectedControlVersion, runtime type descriptors

runtime.validateConfig / runtime.start
  <- runtimeId, runtimeType, name, config, configRevision

runtime.stop
  <- runtimeId
```

Negotiate the control contract in `runtime.discover`, whose current Connector
handler already ignores request parameters. This gives a bounded rolling
adapter without depending on the currently unused handshake models:

- New Server with old Connector: absence of `selectedControlVersion` selects
  `1.0`; expose one synthetic instance per type where `runtimeId == runtimeType`.
- Old Server with new Connector: an empty discover request returns the exact
  legacy `{runtimes: [...]}` response and legacy RPC semantics.
- New Server with new Connector: select `2.0`, discover types, and enable
  instance create/rename/start/stop.
- A Server must reject `rti_*` create or lifecycle operations with
  `runtime_instances_unsupported` when the Connector negotiated `1.0`.

Persist the negotiated control version on the Connector connection. Add old
Server/new Server x old Connector/new Connector contract tests before enabling
instance creation in a client.

## Connector rewrite

Port the old branch's concepts onto current modules, not its file snapshots.

1. Register providers by `runtimeType` and running entries by `runtimeId`.
2. Add `RuntimeInstanceSpec`, instance-bound host/runtime wrappers, per-instance
   lifecycle locks, and cross-instance resource arbitration.
3. Preserve the current DSH runtime sync coordinator and all current provider
   behavior.
4. Codex claims its effective Codex Home as an exclusive source.
5. DSH derives a stable source key and resource claim from its resolved bridge
   endpoint or DSH Home. Two instances must not attach to the same bridge.
6. Claude remains single-instance unless its native config/history source can
   be isolated and claimed explicitly.
7. Native runtime output keeps its provider identity internally. The instance
   wrapper rewrites Server-facing runtime IDs and includes runtime type facts.

## Server and database rewrite

Add a new migration after the current schema head (initially `v2_14`). Never
reuse the old branch's `v2_11` migration.

1. Create `connector_runtime_types` for discovery-owned type facts.
2. Rebuild or migrate `device_runtimes` to instance-owned columns while
   preserving current inventory metadata and config deletion semantics.
3. Preserve every pre-`v2_14` runtime row as a type-equal compatibility
   instance, including discovery-only rows. This keeps the old Web and old
   Connector usable while Server rolls out first. New Runtime Control 2.0 type
   discovery does not create instances implicitly.
4. Legacy inventory reconciliation maintains exactly one compatibility
   instance per provider. Runtime Control 2.0 reconciliation updates type rows
   only; instances are created explicitly.
5. Normalize known DSH rows to runtime type `dsh`; retain `local-service` only
   as category metadata.
6. Add and backfill `sessions.runtime_id` while preserving `sessions.runtime`
   as the type. Add equivalent instance identity to active runs and runtime
   catalogs.
7. Rewrite DSH filters and dashboard facts to use runtime type, not a concrete
   runtime ID string.
8. Keep `DELETE .../config`: stop/deactivate, clear config, and preserve the
   instance/session identity. Hard instance deletion remains a separate design.
9. Add create and rename APIs without removing existing list/config/active
   behavior.
10. Correct unversioned-database detection so `v2_10` through `v2_14` are
    identified by their actual columns instead of stamping every later-looking
    database as the newest revision.

## Web and Android rewrite

1. Refactor the current device and pairing flows around a shared instance
   manager; do not restore stale page snapshots.
2. Preserve current config deletion, startup error tooltip, DSH controls, and
   attachment upload, download, preview, and inline rendering behavior.
3. Routing and composer values use `runtimeId`; labels use the instance name
   with the type display name as secondary context. Existing `runtime` values
   remain provider types during compatibility rollout.
4. Android may keep server-side creation as a Web-only workflow initially, but
   it must accept dynamic instance IDs and render instance names correctly.
5. Permission, model, and reasoning catalog items expose top-level `enabled`
   and `disabledReason`. During rollout, clients read
   `item.enabled ?? item.metadata.enabled ?? true`, exclude disabled values from
   defaults and submission, and render the reason. Do not hide DSH `custom`
   permissions by matching magic IDs.
6. Regenerate protocol types from schemas rather than resolving generated-file
   conflicts manually.
7. Remove native-runtime ID allowlists and filters in Android, while retaining
   DSH metadata such as `storageMode` used by current device guidance.

## Reference-branch disposition

The old DSH/client commits are references, not merge units.

- `9522372`: rewrite the useful behavior. DSH sessions inherit permission
  catalog capability, Web resolves capability by the session's type/instance
  scope, and Web/Android render the default effort correctly. Do not invent a
  model capability the provider does not expose.
- `a705530`: discard the ID-based `custom` filter. Replace it with the generic
  catalog enabled contract above.
- `4a511a0`: split correctness from presentation. Keep suppression of empty
  assistant messages, unknown text fallback, tool name/target extraction, and
  stable group keys. Do not globally hide diff artifacts; activity grouping and
  visual changes belong in a separate UI review.
- DSH Bridge import/checkpoint commits: do not cherry-pick. Rebuild according
  to the ownership, contract, security, and release requirements below.

## DSH Bridge package

The Bridge package is independent of named runtime instances and should be a
separate review unit.

Agents Anywhere owns the protocol, plugin source, compatibility tests, and
release. DSH owns the Host API the plugin consumes. Preserve the upstream
`xipian1216/dsh-aa-bridge` source and commit attribution when importing the
implementation.

- Rewrite from the current placeholder instead of cherry-picking the old
  package commits.
- Treat `contracts/dsh-bridge/1.0` as the only wire-contract source. Remove the
  package-local protocol fixtures and validate the same real request, response,
  notification, and error fixtures from Node and Python.
- Resolve the current contract mismatches before integration: `shutdown`, model
  `reasoningItems`, capability runtime identity, native versus normalized
  timeline payloads, and Bridge error codes.
- Target the current verified DSH release, with a deliberately narrow peer
  range while DSH remains pre-stable. Do not retain the old
  `0.1.0-rc.5..rc.6` range without a compatibility run.
- Use Yarn with a committed lockfile, add package metadata and release CI, and
  install-test the packed tarball. Generated `lib/` output should be produced
  by release unless the repository adopts and verifies a generated-artifact
  policy.
- Harden the loopback server with an authentication deadline, immediate close
  after failed authentication, constant-time token comparison, canonical
  state-root checks, a per-DSH-Home process lock, and a fixed or negotiated
  frame limit.
- Run a real TCP Connector-to-Bridge integration suite plus authentication,
  connection-ownership, oversized-frame, concurrent-process, cross-platform
  file-permission, and headless DSH installation tests.
- The Bridge continues to expose provider identity `dsh`; Connector instance
  binding owns the Server-facing `runtimeId`. Canonical DSH Home or endpoint is
  both the exclusive resource claim and session source key.

## Implementation sequence

Each milestone should be independently reviewable and committed before the
next cross-layer boundary.

1. Protocol/domain models and compatibility decision.
2. Connector supervisor, instance binding, and Codex/Claude/DSH provider
   adaptations.
3. Server migration and repositories.
4. Server lifecycle APIs, session routing, and DSH type-aware source state.
5. Web instance management and composer routing.
6. Android dynamic-ID compatibility and selected DSH UI fixes.
7. Cross-layer regeneration, full tests, production Web build, and migration
   verification.

DSH Bridge packaging and the post-merge DSH UI fixes should use separate PRs
unless the runtime-instance implementation depends on them directly.

## Verification gates

- Connector full tests, focused supervisor/provider tests, Ruff, and Pyright.
- Server full tests, SQLite migration coverage, PostgreSQL-compatible DDL, and
  upgrade tests from current `v2_13` data.
- DSH source-state and archive behavior with dynamic runtime IDs.
- Multiple Codex instances with distinct Homes and conflict rejection for the
  same Home.
- Claude and DSH instance-policy enforcement.
- Web typecheck, lint, protocol check, focused UI tests, and one final
  production build.
- Android unit tests for dynamic runtime IDs, instance labels, catalog enabled
  state, and DSH timeline controls.
- Rolling-version compatibility tests or an explicit incompatible-handshake
  test, according to the chosen rollout policy.
