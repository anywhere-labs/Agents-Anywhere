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

  runtimes/
    codex/
      adapter.py
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
      adapter.py
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

### `server/`

Connector application layer for talking to Agents Anywhere Server:

- connector auth
- HTTP helpers
- WebSocket connection loop
- server RPC dispatch
- ingest batching/flushing
- mapping `RuntimeHostClient` calls to server ingest notifications
- attachment download/upload bridge

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
  list_model_catalog()
  list_sessions()
  start_turn()
  execute_command()
  ...
```

`RuntimeProvider` answers: how do we find, configure, start, and stop this runtime?

`AgentRuntime` answers: once started, how do we interact with this runtime?

This separation keeps Codex executable discovery and IPC configuration out of the generic runtime protocol.

## Provider and supervisor

Target provider shape:

```py
class RuntimeProvider(ABC):
    runtime_id: str
    runtime_type: str
    display_name: str

    async def discover(self, status: str) -> RuntimeInventoryItem: ...
    async def validate_config(self, config: Mapping[str, Any]) -> EffectiveRuntimeConfig: ...
    async def create_runtime(
        self,
        config: EffectiveRuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime: ...
    async def stop_runtime(self, runtime: AgentRuntime) -> None: ...
```

The supervisor owns:

- active runtime instances
- runtime start/stop locks
- runtime status publication
- provider registry
- resolving a runtime id to an active `AgentRuntime`

The supervisor should not know Codex/Claude construction details beyond the provider interface.

## Connector application flow

Startup:

```text
app entrypoint
  -> load config
  -> build server client
  -> build runtime providers
  -> build runtime supervisor
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
