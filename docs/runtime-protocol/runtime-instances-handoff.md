# Runtime Instances Refactor Handoff

Status: cross-layer implementation completed on 2026-08-14; ready for review.

This document is the handoff for the named, multi-instance runtime refactor.
It records the completed implementation, its verification, and the remaining
product risks that should be considered before merging.

## Repository state

- Repository: `Agents-Anywhere`
- Branch: `codex/runtime-instances`
- Last implementation commit: `dd54959 fix(web): refresh runtime choices after instance changes`
- Remote: the branch has been pushed to `origin/codex/runtime-instances`
- Base before this refactor: `836a66a`
- The local and remote branch tips match after each implementation milestone.

Completed implementation commits after the original handoff:

```text
97172e9 feat(server): persist runtime types and named instances
a174acf feat(server): route sessions through runtime instances
8d4db38 feat(web): manage named runtime instances
d8f1b81 fix(web): surface persisted runtime startup errors
dd54959 fix(web): refresh runtime choices after instance changes
```

Connector, Server, protocol schemas, generated Web types, and Web now use the
same runtime type/instance contract. The branch has not been merged into `v2`;
review the known risks below before adoption.

## Product decisions

The following decisions have already been made and should not be reopened
unless requirements change:

1. Codex, Claude, and future ACP integrations are runtime types.
2. One Connector can own multiple runtime instances of the same type.
3. A runtime instance has an immutable `runtimeId`, a `runtimeType`, and an
   editable user-facing `name`.
4. Sessions bind to a concrete `runtimeId`, not just to `codex` or `claude`.
5. Runtime type discovery must not create an unconfigured runtime instance.
6. Web should show added instances, recommended additions, and custom
   additions. It should not show a "discovered but not configured" section.
7. Recommended additions remain available after one instance is added because
   multiple instances of the same type are valid.
8. Runtime-specific config remains schema-driven. Web supplies i18n fallback
   for generic schema components and schema fields.
9. Startup errors are durable instance state on Server and must be visible in
   a Web tooltip. A transient toast alone is insufficient.
10. Runtime interruption remains session-scoped and runtime-owned. This
    refactor must not reintroduce Server-owned turns.

## Completed Connector work

### Runtime type and instance model

The protocol now separates the following concepts:

- `RuntimeTypeDescriptor`: discovery, recommendation metadata, capabilities,
  and config schema for a type.
- `RuntimeInstanceSpec`: `runtimeId`, `runtimeType`, and `name` for one added
  instance.
- `RuntimeIdentity`: the identity exposed by one running instance.
- `RuntimeConfig`: effective config owned by one runtime type.
- `RuntimeResourceClaim`: an exclusive local resource required by a running
  instance.

Relevant files:

- `connector/connector/runtime_protocol/models.py`
- `connector/connector/runtime_protocol/provider.py`
- `connector/connector/runtime_protocol/supervisor_models.py`

### Runtime supervisor

`RuntimeSupervisor` now:

- registers providers by `runtimeType`;
- creates entries dynamically by `runtimeId`;
- supports multiple instances from one provider;
- locks lifecycle operations per instance;
- serializes exclusive resource checks across instances;
- keeps a healthy old runtime running when replacement config validation fails;
- stores structured startup/config errors on the instance entry;
- updates an instance name without restarting its native runtime;
- releases resource claims after stop or failed start.

The supervisor intentionally does not persist config. Server remains the
durable config owner.

Relevant files:

- `connector/connector/runtime_protocol/supervisor.py`
- `connector/connector/runtime_protocol/errors.py`

### Instance binding

`RuntimeInstanceHost` and `RuntimeInstance` bind a native runtime to one
instance. They rewrite runtime-scoped outputs and side effects from the native
type identifier to the concrete instance ID.

The binding covers:

- runtime and session capabilities;
- model and permission catalogs;
- session meta and live state;
- timeline snapshots and items;
- notices and runtime errors;
- sync-state keys;
- runtime identity.

Session identity and sync-state namespaces are instance-aware. If a provider
has a stable source key, the namespace is derived from connector, runtime type,
and a hash of that source key. Otherwise it is derived from connector and
runtime instance ID.

Relevant file:

- `connector/connector/runtime_protocol/instance_binding.py`

### Codex Home

Codex config schema now includes `codexHome`.

Behavior:

- a configured value is expanded and normalized;
- an empty value uses `CODEX_HOME` from the Connector process if set;
- otherwise it uses `~/.codex`;
- the effective value is passed to the Codex SDK through
  `CodexConfig.env["CODEX_HOME"]`;
- generic runtime environment overrides may not set `CODEX_HOME`;
- two running Codex instances with the same effective Home conflict;
- stopping or a failed start releases the Home claim.

The conflict is returned as:

```json
{
  "code": "runtime_resource_conflict",
  "message": "Codex Home '...' is already used by runtime instance '...' (...)"
}
```

Relevant files:

- `connector/connector/runtimes/codex/provider_config.py`
- `connector/connector/runtimes/codex/provider.py`
- `connector/connector/runtimes/codex/sdk/binary.py`
- `connector/connector/runtimes/codex/sdk/client.py`

### Codex and Claude providers

Both providers now expose type descriptors and accept a
`RuntimeInstanceSpec` when creating a runtime. Their native runtime output is
wrapped by the generic instance binding layer.

Codex and Claude are both marked as recommended, with Codex ordered first.

Known Claude limitation: two Claude instances currently have separate platform
namespaces but may read the same native Claude history/config source. Before
claiming full multi-instance isolation for Claude, identify its actual config
and history root, expose that as config if appropriate, and add a provider
source key and/or exclusive resource claim. Otherwise the same native sessions
can appear under multiple platform instance namespaces.

### Connector RPC contract

The current branch intentionally uses a breaking Connector RPC contract:

```text
runtime.discover
  -> { runtimeTypes: RuntimeTypeDescriptor[] }

runtime.configSchema
  <- { runtimeType }

runtime.validateConfig
  <- { runtimeId, runtimeType, name, config, configRevision? }

runtime.start
  <- { runtimeId, runtimeType, name, config, configRevision? }

runtime.stop
  <- { runtimeId }
```

There is no legacy fallback for the old `runtimes` discovery payload or for
starting a runtime with only `runtimeId`.

Relevant files:

- `connector/connector/server/runtime_rpc.py`
- `connector/connector/server/runtime_rpc_params.py`
- `connector/connector/server/runtime_rpc_payloads.py`

### Connector verification

Completed checks:

```text
uv run pytest -q
363 passed

uv run ruff check <changed Connector modules and tests>
All checks passed

uvx pyright --pythonpath .venv/bin/python \
  connector/runtime_protocol \
  connector/runtimes/codex/provider.py \
  connector/runtimes/claude/provider.py \
  connector/server/runtime_rpc.py
0 errors, 0 warnings
```

Full-repository Ruff is not currently clean because `_reference` and unrelated
legacy modules contain existing warnings. Do not mix that cleanup into this
refactor.

## Completed Server work

Server work was completed in two independently verified commits: `97172e9` for
storage/API and `a174acf` for concrete instance session routing.

### 1. Runtime type catalog table

Migration `v2_11` and schema revision `2.11` add the type catalog and migrate
the old inventory rows.

`connector_runtime_types` has a composite primary key of
`connector_id + runtime_type` and contains type-owned discovery data:

```text
connector_id
runtime_type
display_name
description
available
recommended
recommendation_rank
discovery_json
config_schema_json
ui_schema_json
defaults_json
capabilities_json
metadata_json
last_discovered_at
updated_at
```

`device_runtimes` is instance-owned storage:

```text
connector_id
runtime_id
runtime_type
name
name_key
config_json
active
status
error_json
created_at
updated_at
```

`name_key` provides a normalized, case-insensitive uniqueness constraint per
Connector without database-specific case-insensitive collation.

Discovery does not overwrite instance name, config, active state, status, or
error. Type availability is read by joining the instance to its latest type
descriptor.

Migration rules for existing rows:

1. Copy every old `device_runtimes` row into `connector_runtime_types`.
2. Preserve rows with non-null `config_json` as instances. Keep their existing
   `runtime_id`, active state, status, error, and display name as the instance
   name.
3. Old rows that only represented discovery and have no config or sessions
   become type rows only.
4. If an unconfigured old row is referenced by existing sessions, preserve a
   legacy inactive instance so those sessions keep a concrete binding. This is
   a migrated instance, not a newly discovered placeholder.
5. Verify both SQLite migration tests and PostgreSQL-compatible DDL.

Primary files:

- `server/migrations/versions/v2_11.py`
- `server/agent_server/infra/db/schema.py`
- `server/agent_server/infra/db/__init__.py`
- `server/agent_server/infra/db/migrations.py`
- `server/agent_server/infra/repositories/device_runtimes.py`
- `server/agent_server/services/repository_ports.py`
- `server/tests/test_database_migrations.py`
- `server/tests/conftest.py`

### 2. Type and instance API models

The old `RuntimeInventory` model was replaced with a runtime type catalog model
that parses Connector `runtimeTypes`.

Response/request models cover:

- listing runtime types;
- listing runtime instances;
- creating an instance from a runtime type;
- renaming an instance;
- updating config and active state.

Instance creation accepts:

```json
{
  "runtimeType": "codex",
  "name": "Work Codex",
  "config": {
    "codexHome": "/Users/example/.codex-work"
  },
  "active": true
}
```

Server generates `rti_<token>` IDs and inserts an instance before
validation/start so asynchronous `runtime.statusChanged` notifications attach
to an existing row.

The instance response exposes explicit fields:

```text
runtimeId
runtimeType
name
typeDisplayName
active
status
config
error
available
schema
uiSchema
defaults
```

`displayName` may temporarily mirror `name` for mobile compatibility, but new
Web code should use `name`.

Implemented routes:

```text
GET  /api/v2/connectors/{connectorId}/runtime-types
POST /api/v2/connectors/{connectorId}/runtime-types/discover
GET  /api/v2/connectors/{connectorId}/runtimes
POST /api/v2/connectors/{connectorId}/runtimes
PATCH /api/v2/connectors/{connectorId}/runtimes/{runtimeId}
PUT  /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/config
PUT  /api/v2/connectors/{connectorId}/runtimes/{runtimeId}/active
```

Hard deletion remains deliberately absent. A runtime instance referenced by
sessions must not be silently deleted; a future design should use a 409 or
soft deletion.

### 3. Server lifecycle RPC

All validation and start calls include instance identity:

```json
{
  "runtimeId": "rti_...",
  "runtimeType": "codex",
  "name": "Work Codex",
  "config": {},
  "configRevision": 123
}
```

This applies to:

- `DeviceRuntimeService._request_validate()`;
- `DeviceRuntimeService._start_locked()`;
- reconciliation of active instances;
- rename propagation for a running instance.

For a running rename, calling `runtime.start` again with the same config and the
new name is acceptable. Connector updates the wrapper identity without
restarting the native runtime.

Type discovery no longer calls stop on a type that Server did not activate.
Reconciliation operates only on persisted instances.

### 4. Durable startup errors

The implemented error path is:

```text
Connector start/validation failure
  -> structured Connector RPC error and runtime.statusChanged
  -> Server device_runtimes.error_json
  -> GET runtime instances returns error
  -> Web instance error badge tooltip
```

`DeviceRuntimeService._start_locked()` leaves `active=true`, sets
`status=error`, stores `code/message`, and raises an HTTP error.

The HTTP error `detail` contains the same structured payload stored on the
instance rather than replacing the Connector message with a generic 502.

### 5. Dynamic session runtime IDs

Runtime fields now use a bounded runtime ID string model rather than a known
runtime type literal.

The dynamic model applies to:

- `SessionCreateRequest` and `SessionCreateAndStartRequest`;
- `SessionView` and `SessionRuntimeState`;
- timeline, notice, approval, capability, and catalog source models;
- Connector notification parsing;
- runtime catalog routes.

Session creation and session operations validate the concrete instance through
`DeviceRuntimeService.ensure_active_running()`.

External-session reconciliation now includes the concrete runtime ID:

```text
connector_id + runtime_id + external_session_id
```

The same scoping is applied to `resolve_connector_session_id()` and Connector
session upsert paths, so two native sources cannot merge into one platform
session.

No Server turn table or turn-aware interrupt logic was added.

## Completed Web work

Web work was completed after the Server endpoints stabilized, in commits
`8d4db38` and `d8f1b81`.

### 1. Instance management UI

The device page contains:

- added runtime instances;
- a recommended-add list sorted by `recommendationRank`;
- a custom-add action that lets the user choose any available runtime type.

The "Discovered, not configured" section was removed. A discovered type is not
an instance.

The add flow collects:

1. runtime type;
2. instance name;
3. schema-driven runtime config;
4. whether to start immediately, normally true for the primary action.

The generic schema renderer is reused without Codex- or Claude-specific form
branches.

Task composer choices use active instances:

- option value: `runtimeId`;
- option label: instance `name`;
- optional secondary label: `typeDisplayName`.

### 2. Startup error tooltip

The shared manager renders a destructive error badge with a tooltip when
`runtime.error` exists and refreshes durable state after failed requests.

For create/start, activate, config restart, and pairing start failures:

1. retain the immediate toast;
2. fetch the runtime instance list again in the catch path;
3. update local state without hiding the original error;
4. keep the config dialog open when appropriate;
5. render the persisted `runtime.error` in the instance row tooltip.

`RuntimeErrorBadge` is shared by the manager used on both the device and
pairing screens.

The tooltip should prefer `error.message`, then a meaningful nested message,
then `error.code`. Do not expose a raw JSON object as the primary UI.

### 3. Schema i18n

Connector already emits these Codex Home keys:

```text
dashboard.device.runtimeConfigFields.codexHome.label
dashboard.device.runtimeConfigFields.codexHome.description
```

They are present in:

- `web-next/messages/en.json`
- `web-next/messages/zh-CN.json`

The same locale files include recommended add, custom add, runtime instance
name, type selection, rename, and conflict/error copy.

Schema rendering should continue to fall back to Web-owned generic component
copy when a schema does not provide an i18n key. This applies to generic
components such as `customModels`, `modelGateway`, `keyValue`, and `path`.

### 4. Pairing flow

After pairing completes, Web now:

1. discover runtime types;
2. fetch existing instances;
3. show recommended additions and custom add;
4. configure/create/start the selected instance;
5. show any persisted startup error in a tooltip after refresh.

The flow does not auto-create one instance per discovered type.

## Verification

Completed verification:

```text
Connector: 363 passed
Server: 398 passed, 14 skipped
Web: 7 runtime instance tests passed
Web: typecheck, lint, and protocol:check passed
Web: final production build passed
```

Coverage includes the original required cases below.

### Server

- Migration copies old discovery rows into runtime type catalog.
- Configured old runtimes remain instances with the same ID and session binding.
- Discovery-only rows do not become normal new instances.
- Two named instances of one type can be created.
- Duplicate instance names on one Connector are rejected.
- Validation/start RPC includes `runtimeId`, `runtimeType`, and `name`.
- First Codex instance starts with a Home; second instance using the same Home
  returns `runtime_resource_conflict`.
- The first instance remains running after the second conflicts.
- The failed instance remains active/configured with `status=error` and the
  exact structured error returned by GET.
- A generic startup failure also persists its exact message.
- Unknown pre-instance status notifications are ignored without disconnecting.
- Dynamic runtime IDs are accepted throughout session/timeline/notice models.
- External session fallback is scoped by runtime instance.

### Connector

Keep the current 363-test suite green. Add a direct Codex-provider integration
test for equivalent Home spellings if the path canonicalization logic changes.

### Web

- TypeScript typecheck and lint.
- Recommended and custom add flows use type descriptors.
- Added instances remain distinct when their type matches.
- Composer sends the selected instance ID.
- Failed start refreshes the instance and exposes the Server message in the
  tooltip on both device and pairing screens.
- Codex Home labels and descriptions render in English and Chinese.

Run one final Web build after the UI work. Do not repeatedly run expensive
local builds during incremental edits, and do not start a development server
unless explicitly requested.

## Known risks

1. Claude source isolation is not complete. Multiple wrappers work, but native
   history/config ownership needs an explicit provider decision.
2. Codex Home normalization uses `Path.resolve(strict=False)`. Existing
   symlinks resolve correctly, but case-only aliases on a case-insensitive
   filesystem should be tested before treating canonicalization as exhaustive.
3. Existing mobile clients read `displayName`. Keep a temporary response alias
   or update mobile clients in the same release.
4. Hard-deleting an instance can orphan session bindings. Define deletion or
   soft-deletion semantics first.
5. Runtime type availability and instance lifecycle status are separate facts.
   Do not collapse them back into one `status` field.

## Completed commit sequence

1. `feat(server): persist runtime types and named instances`
   - migration, schema, repository, core models, migration tests
2. `feat(server): route sessions through runtime instances`
   - service/API/RPC changes, dynamic runtime IDs, session reconciliation tests
3. `feat(web): manage named runtime instances`
   - recommended/custom add, naming, composer instance selection, i18n
4. `fix(web): surface persisted runtime startup errors`
   - shared tooltip component and failed-request refresh behavior
5. `fix(web): refresh runtime choices after instance changes`
   - cross-screen inventory invalidation and exact runtime ID preservation
6. Final cross-layer verification and documentation update

All implementation milestones were pushed independently to
`origin/codex/runtime-instances`.

## Resume checklist

```text
git switch codex/runtime-instances
git pull --ff-only origin codex/runtime-instances
git status --short --branch
git log --oneline --decorate -6
```

Then review the five completion commits and the known risks above. Do not
reintroduce the old runtime inventory compatibility path.
