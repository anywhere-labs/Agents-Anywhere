# Connector and Runtime Migration

The v2 Connector replaces the `main` adapter registry with a typed runtime
protocol and moves transport, runtime, and local-operation code into one-way
layers.

## Architecture mapping

| `main` concept | v2 concept |
| --- | --- |
| Dict-shaped `Adapter` protocol | `AgentRuntime` abstract runtime contract |
| `build_default_adapters()` | `RuntimeProvider` discovery and lifecycle composition |
| Adapter `notification_sink` | `RuntimeHostClient` callbacks |
| `BackendRpcClient` owns adapters and runtime details | Server-layer client coordinates `RuntimeSupervisor` and runtime RPC mapping |
| Root `runtime.py`, `adapter.py`, and runtime-specific packages | `core/`, `server/`, `runtime_protocol/`, and `runtimes/*` |
| SQLite sync-state store | Atomic JSON state through host sync-state methods |
| Runtime-specific dict probing across layers | Typed dataclasses and SDK-specific parsing inside the runtime package |

The dependency direction is:

```text
Connector app -> server transport -> runtime protocol
server transport -> runtime host mapping
runtimes/* -> runtime protocol + native SDK details
```

Generic Connector code must not import Codex or Claude implementation modules.

## Two protocol directions

`AgentRuntime` represents Connector-to-runtime operations, including:

- discovery/configuration lifecycle through `RuntimeProvider`;
- live capabilities, model/permission catalogs, session state, and notices;
- session discovery and timeline snapshots;
- create-and-start, send, steer, interrupt, and selection updates;
- runtime command listing/execution and interaction responses.

`RuntimeHostClient` represents runtime-to-platform effects, including:

- session metadata and live-state updates;
- capability and catalog updates;
- timeline snapshot/item writes;
- notice updates and explicit runtime errors;
- attachment downloads and local sync-state reads/writes.

Runtime integrations should return explicit unsupported results or errors. They
must not silently fall back to a different message path or restore the old
adapter contract.

## Runtime support matrix

| Runtime | `main` | v2 baseline | Migration consequence |
| --- | --- | --- | --- |
| Codex | Local CLI/app-server adapter with IPC-related integration | Native provider using `openai-codex`; active code is SDK-only | Remove `CODEX_BIN`, app-server, and IPC assumptions from deployment/configuration. |
| Claude | Claude SDK adapter | Native `ClaudeProvider`/`ClaudeRuntime` | Revalidate the declared capability subset; unsupported behavior must remain visible. |
| Gemini ACP | Built-in ACP manifest | No active provider | Block cutover for users who require it, or implement a v2 provider first. |
| Cursor ACP | Built-in ACP manifest | No active provider | Same as above. |
| Grok Build ACP | Built-in ACP manifest | No active provider | Same as above. |
| CodeBuddy ACP | Built-in ACP manifest | No active provider | Same as above. |

The old implementations under `connector/_reference/` are reference material,
not runtime fallbacks. Production code must not import them.

## Server URL and namespace

Keep `serverUrl` as an origin:

```json
{
  "serverUrl": "https://agents.example.com"
}
```

Do not store `https://agents.example.com/api/v2`. The Connector URL helpers add
the namespace for auth, ingest, WebSocket, attachment, transfer, relay, pairing,
and health calls.

## Local data migration

The default data location changes from `~/.agent-server` to
`~/.agents-anywhere`.

| `main` | v2 |
| --- | --- |
| `~/.agent-server/connector.json` | `~/.agents-anywhere/connector.json` |
| `stateDbPath` | `statePath` |
| `AGENT_CONNECTOR_STATE_DB` | `AGENT_CONNECTOR_STATE_FILE` |
| `connector-state.sqlite3*` | `connector-state.json` |
| no data-root override | `AGENT_CONNECTOR_DATA_DIR` |

On first access, v2 moves files from the legacy directory into the canonical
directory, renames collisions with `.legacy-N`, deletes the obsolete Connector
SQLite sync-state files, and removes the empty legacy directory.

This is an automatic, destructive local migration. Before first v2 start:

1. Stop every Connector process that uses the legacy directory.
2. Back up the complete `~/.agent-server` directory.
3. Record any explicit `AGENT_CONNECTOR_CONFIG` or `stateDbPath` override.
4. Start one v2 Connector and inspect `~/.agents-anywhere` before deploying it
   broadly.
5. Confirm the config file remains mode `0600` and the data directory mode
   `0700` on platforms that support POSIX modes.

The old SQLite sync cursor is intentionally not imported. The v2 Connector can
resynchronize session metadata/timeline from runtime and Server state.

## Runtime configuration migration

Runtime configuration is Server-owned. The Connector validates provider config
and starts/stops runtimes through the supervisor; it must not establish a second
durable configuration source locally.

For each Connector after upgrade:

1. Call runtime discovery.
2. Confirm only expected native providers are listed.
3. Read each runtime config schema from the Connector-scoped runtime endpoint.
4. Reapply/validate migrated configuration.
5. Activate the runtime and verify the reported effective config.
6. Read runtime and session capabilities before enabling UI actions.

Do not infer support from the runtime name. Use declared capabilities for
attachments, catalogs, send, steer, interrupt, approvals, and commands.

## Session behavior changes

- `session.create` is a bind/import operation for an existing external session.
- New user tasks use create-and-start so the Server allocates the platform
  session id before the runtime emits timeline events.
- Existing-session messages do not include model or permission fields.
- Commands are separate runtime operations and must not become user messages on
  lookup or execution failure.
- Timeline items are platform types before leaving a runtime package. SDK method
  names and objects stay inside that package.
- Runtime state, selections, notices, catalogs, and capabilities are live facts.
  Connector reconnect/discovery must republish or make them readable.

## Connector verification

At minimum, verify:

```bash
cd connector
uv run pytest tests/test_runtime_protocol.py \
  tests/test_runtime_protocol_supervisor.py \
  tests/test_connector_runtime_host.py \
  tests/test_codex_runtime.py \
  tests/test_claude_runtime.py -q
```

Then test against the actual runtime SDK versions installed on target Connector
hosts. Unit tests do not prove local credentials, runtime binary/SDK discovery,
workspace permissions, or headless behavior.
