# Connector Structure Target

Status: draft.

This document describes the target Connector module structure for the Agent Runtime Protocol refactor. It complements the protocol ABC documents by defining where responsibilities should live.

## Current problem

The current Connector has useful pieces, but the boundaries are blurred:

- `runtime.py` mixes server WebSocket/auth, dispatch, notification flush, runtime sync loops, and local ops routing.
- `runtime_lifecycle.py` mixes generic lifecycle orchestration with Codex/Claude provider construction.
- runtime adapters return `backendNotifications` or call `notification_sink` directly.
- runtime discovery logic is centralized instead of owned by each runtime provider.
- root-level modules contain both framework primitives and product/runtime code.

The refactor should make the Connector application layer depend on generic runtime abstractions, not concrete Codex/Claude modules.

## Target tree

```text
connector/connector/
  app/
    cli.py
    controller.py
    desktop_rpc.py

  core/
    config.py
    logging.py
    paths.py
    revision.py
    sync_state.py
    time.py

  server/
    auth.py
    client.py
    dispatch.py
    ingest.py
    notifications.py
    rpc.py

  runtime/
    errors.py
    host.py
    models.py
    protocol.py
    provider.py
    registry.py
    supervisor.py

  _reference/
    codex/
    claude/
    runtime_discovery.py

  runtimes/
    codex/
      runtime.py
      history.py
      provider.py
      reducer.py
      rpc.py
      ipc/
        client.py
        protocol.py
        publisher.py
        state.py

    claude/
      runtime.py
      history.py
      normalized.py
      normalizers.py
      provider.py
      reducer.py
      timeline_identity.py
      trust.py

  local/
    common.py
    file_ops.py
    ops.py
    shell.py
    terminal.py

  transport/
    json_rpc.py
    launch.py
```

The first implementation does not need to move every file at once. The tree is the target shape. Prefer incremental commits that create the protocol layer before performing large moves.

Existing Codex/Claude implementations from the pre-protocol adapter architecture live under `_reference/`. They are retained only as migration source material and must not be imported by the active Connector runtime path. New implementations should be written under `runtimes/codex` and `runtimes/claude` against `RuntimeProvider`, `AgentRuntime`, and `RuntimeHostClient`.

## Layer responsibilities

### `app/`

User-facing and desktop-control entry points:

- CLI command parsing.
- Desktop JSON-RPC controller.
- Pairing control exposed to local UI.
- Start/stop/restart of the Connector process from desktop RPC.

`app/` may create the Connector application, but it should not know Codex/Claude adapter internals.

### `core/`

Small shared primitives:

- config file loading/saving
- paths
- logging
- UTC time helpers
- revision clocks
- sync state storage

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

Current implementation has started this split with:

```text
server/runtime_host.py
  ConnectorRuntimeHost
```

`ConnectorRuntimeHost` is the compatibility boundary that maps semantic runtime host calls to the current `session.updated`, `timeline.sync`, `timeline.itemUpsert`, `notice.upsert`, and `runtime.error` ingest notifications. Runtime adapters should call the host client, not emit server notification method names themselves.

`server/` owns the actual network client. Runtime adapters must not call server HTTP/WS directly.

### `runtime/`

Generic runtime framework:

- `AgentRuntime` ABC
- `RuntimeHostClient` ABC
- dataclass models
- runtime errors
- provider lifecycle interface
- registry/supervisor
- runtime dispatch helpers

`runtime/` must not import Codex/Claude modules. Concrete providers are registered by composition.

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

Current Codex native package:

```text
runtimes/codex/provider.py
runtimes/codex/runtime.py
```

The first native `CodexRuntime` slices support startup, config readback, model catalog reads, static permission catalog reads, existing session metadata reads through `thread/list`, session snapshots through `thread/read`, text-only `create_and_start_session()`, text-only `start_turn()`, text-only `steer_turn()`, local `interrupt_turn()`, basic `waiting`/`running`/`idle` state updates, and minimal live timeline upserts from app-server item/turn notifications. Attachments, notices, full reducer parity, and IPC co-presence remain later Codex runtime slices.

### `local/`

Local machine operations that are not agent-runtime-specific:

- filesystem reads/writes
- shell commands
- terminal sessions
- path validation

These are host capabilities exposed through server RPC, not part of `AgentRuntime`.

### `transport/`

Generic low-level transports:

- local JSON-RPC stdio server/client helpers
- process launch target helpers

Transport code should not know runtime protocol semantics.

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
  -> provider.create_runtime(RuntimeConfig, RuntimeHostClient)
  -> AgentRuntime.start()
  -> status = running
```

If the same runtime is already running with the same effective config values, `start()` returns the existing `AgentRuntime`. If config values differ, the supervisor stops the old runtime before creating a new one.

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
app -> server, core
server -> runtime, local, core
runtime -> core
runtimes/* -> runtime, transport, core
local -> core
transport -> core
```

Avoid:

```text
runtime -> runtimes/*
runtimes/* -> server network client
runtimes/* -> server notification method names
local -> runtimes/*
core -> server/runtime/runtimes/local
```

## Migration approach

1. Add `runtime/` protocol and host abstractions without moving existing adapters.
2. Add a host-client implementation that maps protocol host calls to current ingest behavior.
3. Adapt Codex to use `RuntimeHostClient` while keeping file locations stable.
4. Adapt Claude similarly.
5. Split `runtime.py` into `server/client.py`, `server/dispatch.py`, and `server/notifications.py`.
6. Move concrete providers from generic lifecycle code into `runtimes/*/provider.py`.
7. Move files into the target tree once import boundaries are enforced by tests.

Large file moves should happen after behavior is covered by protocol tests, so review can separate behavior changes from path churn.
