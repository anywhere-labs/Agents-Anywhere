# Connector Structure

Status: current target and migration map.

This document describes the Connector module structure for the Agent Runtime
Protocol refactor. It is authoritative for active Connector code organization:
old adapter code may be mined as migration source material, but active code
should flow through `RuntimeProvider`, `AgentRuntime`, and `RuntimeHostClient`.

## Migration stance

This refactor is a breaking migration. Merging useful logic from old Codex or
Claude adapters is part of migration, but keeping the old adapter contract in
the active path is not.

Rules:

- Do not add shims for removed root modules such as `connector.runtime`,
  `connector.adapter`, `connector.codex`, or `connector.claude`.
- Do not add a legacy adapter wrapper around `backendNotifications` or
  `notification_sink`.
- Runtime code must call `RuntimeHostClient` semantic methods and must not emit
  server notification method names directly.
- `_reference/` is read-only source material for migration. It must not be
  imported by the active Connector runtime path.
- Connector-local durable state uses JSON stores. SQLite is not part of the v2
  Connector path.

These rules are enforced by `connector/tests/test_connector_architecture.py`.

## Current tree

```text
connector/connector/
  cli.py
  control.py
  launch.py
  logging.py
  paths.py
  time.py

  core/
    config.py
    json_rpc.py
    preferences.py
    runtime_config_store.py
    runtime_owner.py

  server/
    auth.py
    catalogs.py
    client.py
    dispatch.py
    ingest.py
    protocol.py
    protocol_revision.py
    rpc.py
    runtime_host.py
    sync_state.py
    urls.py

  runtime_protocol/
    attachments.py
    errors.py
    host.py
    models.py
    protocol.py
    provider.py
    supervisor.py

  runtimes/
    providers.py
    codex/
      runtime.py
      provider.py

    claude/
      runtime.py
      provider.py

  local/
    common.py
    file_ops.py
    ops.py
    shell.py
    terminal.py

  _reference/
    codex/
    claude/
    legacy/
    runtime_discovery.py
```

The root package is now intentionally thin. It still contains CLI/control
entrypoints and small cross-layer utilities. Large mixed modules such as
`runtime.py`, `adapter.py`, `runtime_lifecycle.py`, root `json_rpc.py`,
root `attachments.py`, root `protocol_revision.py`, and root `sync_state.py`
have been removed from the active root.

`runtime_protocol` is the current package name because the historical
`connector.runtime` root module existed when the protocol was introduced. Do
not rename it casually; if we later rename it to `connector.runtime`, do it as
a dedicated breaking move after all old root paths are gone and guarded.

## Layer responsibilities

### Root entrypoints

User-facing and desktop-control entry points:

- CLI command parsing.
- Desktop JSON-RPC controller.
- Pairing control exposed to local UI.
- Start/stop/restart of the Connector process from desktop RPC.

Root entrypoints may assemble the Connector application. They must not know
Codex/Claude adapter internals.

### `core/`

Small shared primitives:

- config file loading/saving
- local preferences
- JSON-RPC frame helpers for local control
- runtime config persistence
- runtime owner lock/state helpers

`core/` must not import runtime adapters or server application code.

Runtime config persistence:

```text
core/runtime_config_store.py
  JsonRuntimeConfigStore
```

The runtime config store persists raw runtime config values by runtime id in the canonical Connector data directory:

```text
~/.agents-anywhere/runtime-configs.json
```

It is JSON-backed and replaces sqlite for Connector-local runtime configuration. It does not validate runtime semantics; validation belongs to `RuntimeProvider.validate_config()`. It does not store running runtime state; lifecycle state belongs to the supervisor.

### `server/`

Connector application layer for talking to Agents Anywhere Server:

- connector auth
- HTTP helpers
- WebSocket connection loop
- server RPC dispatch
- ingest batching/flushing
- mapping `RuntimeHostClient` calls to server ingest notifications
- attachment download/upload bridge

Current implementation:

```text
server/client.py
  BackendRpcClient

server/runtime_host.py
  ConnectorRuntimeHost

server/dispatch.py
  ConnectorRequestDispatcher

server/ingest.py
  ConnectorIngestClient

server/sync_state.py
  JsonSyncStateStore
```

`ConnectorRuntimeHost` is the transport mapping boundary that maps semantic runtime host calls to server ingest notifications such as `session.updated`, `timeline.sync`, `timeline.itemUpsert`, `notice.upsert`, and `runtime.error`. Runtime adapters should call the host client, not emit server notification method names themselves.

`server/` owns the actual network client. Runtime adapters must not call server HTTP/WS directly.

### `runtime_protocol/`

Generic runtime framework:

- `AgentRuntime` ABC
- `RuntimeHostClient` ABC
- dataclass models
- runtime errors
- provider lifecycle interface
- registry/supervisor
- runtime dispatch helpers

`runtime_protocol/` must not import Codex/Claude modules. Concrete providers
are registered by composition in `runtimes/providers.py`.

### `runtimes/*/`

Concrete runtime integrations.

Each runtime package owns:

- runtime discovery
- config validation details
- adapter construction
- native process/SDK/IPC integration
- native event reduction into protocol timeline/state/selection projections
- runtime-specific sync state keys

For example, Codex owns app-server stdio, Codex IPC, local rollout history, and Codex reducer logic. Claude owns SDK integration, transcript/history normalization, and trust handling.

Runtime packages implement `AgentRuntime` and call `RuntimeHostClient`.

Current native runtime packages:

```text
runtimes/codex/provider.py
runtimes/codex/runtime.py
runtimes/claude/provider.py
runtimes/claude/runtime.py
```

The first native Codex/Claude runtimes are protocol implementations, not
adapter wrappers. They may still be feature-incomplete; unsupported behavior
must be explicit through `RuntimeUnsupportedError` or an unsuccessful protocol
result.

### `local/`

Local machine operations that are not agent-runtime-specific:

- filesystem reads/writes
- shell commands
- terminal sessions
- path validation

These are host capabilities exposed through server RPC, not part of `AgentRuntime`.

## Runtime lifecycle model

Lifecycle is separate from runtime interaction.

```text
RuntimeProvider
  discover()
  validate_config()
  create_runtime()
  stop_runtime()

AgentRuntime
  get_config()
  list_model_catalog()
  list_sessions()
  start_turn()
  execute_command()
  ...
```

`RuntimeProvider` answers: how do we find, configure, start, and stop this runtime?

`AgentRuntime` answers: once started, how do we interact with this runtime, including reading its effective runtime-owned config.

This separation keeps discovery/bootstrap details out of session operations, while still making runtime config visible through the generic runtime protocol. For example, Codex SDK mode, Codex IPC enablement, executable path, and local feature flags belong to runtime config, not to `ConnectorConfig`. Config mutation flows through `RuntimeProvider` and the supervisor, not through a running `AgentRuntime`.

## Provider and supervisor

Target provider shape:

```py
class RuntimeProvider(ABC):
    @property
    def runtime(self) -> str: ...

    @property
    def runtime_type(self) -> str: ...

    @property
    def display_name(self) -> str: ...

    async def discover(self) -> RuntimeInventoryItem: ...
    async def get_config_schema(self) -> RuntimeConfigSchema: ...
    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig: ...
    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime: ...
    async def stop_runtime(self, runtime: AgentRuntime) -> None: ...
```

`get_config_schema()` is for live UI/CLI form rendering. `validate_config()` is the authoritative startup-time validation and normalization step; schema validation may be part of it, but provider code must still perform runtime-specific checks such as executable presence, SDK availability, socket availability, and OS-specific support.

The supervisor owns:

- active runtime instances
- runtime start/stop locks
- runtime status publication
- provider registry
- resolving a runtime id to an active `AgentRuntime`

The supervisor should not know Codex/Claude construction details beyond the provider interface.

Current protocol implementation:

```text
runtime_protocol/supervisor.py
  RuntimeSupervisor
  RuntimeSupervisorEntry
```

The protocol supervisor is intentionally not a config store. It accepts raw config values for `validate_config()` and `start()`, delegates validation to `RuntimeProvider`, and keeps only the effective `RuntimeConfig` associated with an active runtime. Durable runtime config storage belongs in `core/runtime_config_store.py`.

Supervisor start flow:

```text
start(runtime, raw_values)
  -> provider.validate_config(raw_values)
  -> effective RuntimeConfig
  -> if already running with same raw values: return existing runtime
  -> if already running with same effective RuntimeConfig: keep existing runtime
     and update the remembered accepted raw values
  -> if validation fails while an old runtime is running: keep the old runtime
     running and return the validation error to the caller
  -> only after successful validation of a changed effective config:
     stop old runtime if present
  -> provider.create_runtime(RuntimeConfig, RuntimeHostClient)
  -> AgentRuntime.start()
  -> status = running
```

The supervisor must never stop a healthy running runtime before the replacement
configuration has been validated. Raw config values and effective config values
are intentionally distinct: providers may normalize `auto` or aliases into a
stable effective config, and equivalent effective configs should not force a
restart.

`validate_config(runtime, raw_values)` is a validation-only call. If the runtime
is already running, it must not mark the runtime stopped and must not replace
the active effective config. Validation failures should be returned to the
caller while preserving the currently running runtime.

## Connector application flow

Startup:

```text
app entrypoint
  -> load config
  -> build server client
  -> build runtime providers
  -> build runtime supervisor
  -> for each provider:
       discover()
       get_config_schema()
       load raw runtime config values
       validate_config(raw values) -> RuntimeConfig
       create_runtime(RuntimeConfig, RuntimeHostClient)
       AgentRuntime.start()
  -> connect server websocket
  -> discover runtimes
  -> publish runtime inventory/status
```

Server RPC dispatch:

```text
server websocket request
  -> server.dispatch
  -> resolve active AgentRuntime
  -> call AgentRuntime method
  -> return RuntimeOperationResult or typed result
```

Runtime event flow:

```text
runtime adapter
  -> RuntimeHostClient semantic method
  -> server.ingest/notifications maps to server payload
  -> server persists projection/timeline/notice
  -> web receives websocket/event update
```

## Dependency rules

Allowed:

```text
root entrypoints -> server, core
server -> runtime, local, core
runtime_protocol -> core
runtimes/* -> runtime_protocol, core
local -> core
```

Avoid:

```text
runtime_protocol -> runtimes/*
runtimes/* -> server network client
runtimes/* -> server notification method names
local -> runtimes/*
core -> server/runtime_protocol/runtimes/local
```

## Completed migration nodes

- Added `runtime_protocol` ABCs and dataclasses.
- Added `RuntimeProvider`, `RuntimeSupervisor`, and JSON runtime config store.
- Connector startup restores saved JSON runtime configs through the supervisor.
- Added native `runtimes/codex` provider/runtime.
- Added native `runtimes/claude` provider/runtime.
- Moved server transport/client/dispatch/ingest/sync/protocol helpers under
  `server/`.
- Moved local operations under `local/`.
- Moved connector-local runtime owner and JSON-RPC helpers under `core/`.
- Moved attachment helpers under `runtime_protocol/`.
- Moved old Codex/Claude/adapter code under `_reference/`.
- Added architecture tests that forbid active imports of deprecated root
  modules.

## Remaining migration nodes

1. Finish runtime command support:
   - command catalog is read live from `AgentRuntime.list_commands()`;
   - execution calls `AgentRuntime.execute_command()`;
   - command execution must not create a normal user message.
2. Finish live state fidelity:
   - `SessionState.status` is the UI running-state source;
   - tool calls and IPC events keep status interruptible while work is active.
3. Finish Codex IPC parity:
   - map IPC state/timeline/notice changes into host-client calls;
   - keep IPC-specific method names inside the Codex runtime package.
4. Finish create-and-start attachment design:
   - current create-and-start path is text-first;
   - new-session attachment upload needs a draft/preallocation flow before it
     is enabled in Web.
5. Finish Web protocol-driven reads:
   - live command menu on `/`;
   - live model/permission catalog reads at interaction time;
   - no periodic snapshot polling except explicit recovery.
6. Remove or replace old server API projections that still exist only for
   migration visibility.

Each remaining node should be independently testable and should avoid adding
legacy compatibility wrappers.
