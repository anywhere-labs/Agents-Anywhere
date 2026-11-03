# Runtime Control 2.1 Contract

Runtime Control is the Server-to-Connector RPC contract for discovering and
operating runtime types and named runtime instances. Server and Connector are
released together and use one protocol. Runtime requests never negotiate versions
or depend on a persisted compatibility mode.

The files under this directory are the source of truth for Runtime Control 2.1.
It is an additive revision of `contracts/runtime-control/2.0`, which stays
frozen: 2.1 adds Connector protocol features to discovery, the switch fence
on `runtime.validateConfig` and `runtime.start` (see [Switch fence](#switch-fence)),
and `runtime.probeModelConnection` (see [Model probe](#model-probe)).
Every 2.0 payload is still valid under 2.1. `contracts/protocol/1.0` is frozen
and must not be changed to implement named runtime instances.

## Identity

Runtime Control 2.1 keeps provider and instance identity separate:

- `runtimeType` is the immutable provider key on type and instance records,
  such as `codex`, `claude`, or `dsh`.
- `runtime` has the same provider-type meaning in every scoped RPC payload.
- `runtimeId` is the immutable identity of one configured instance.
- `name` is user-editable and is never used as an identity or source key.
- `implementationType` is a nullable implementation category such as
  `local-service`; it is not a substitute for `runtime` or `runtimeType`.

Provider IDs use the canonical lowercase token grammar and must not start with
the reserved `rti_` prefix. A `runtimeId` is either that canonical provider ID
for a legacy compatibility instance or an opaque `rti_` ID containing only
ASCII letters, digits, `_`, and `-` after the prefix. For a legacy instance,
the application layer must verify `runtimeId == runtime`; JSON Schema cannot
express equality between those two fields.

After an instance is created, implementations must reject changes to its
`runtimeId` or `runtimeType`. Renaming an instance does not change its session
namespace and does not, by itself, restart the runtime.

`instancePolicy` is `single` or `multiple`. A single-instance provider has
`maxInstances: 1`. A multiple-instance provider has an integer limit of at
least two, or `null` when the provider does not impose a fixed count. The limit
applies at two layers. Server limits the number of configured instances of a
type to it, so a type at its limit is not addable. Connector limits the number
of simultaneously running instances and does not count a stopped or deleted
configuration; it must release a deleted instance's slot so a replacement can be
configured at once. Resource claims may still prevent two otherwise valid
instances from using the same native source.

Implementation models and generated client types must use the exact
`single`/`multiple` tokens; `singleton` is not a Runtime Control 2.1 value.

## Discovery

The Server calls `runtime.discover` with an empty parameter object:

```json
{}
```

The Connector returns provider descriptors:

```json
{
  "runtimeTypes": [],
  "features": ["switchFence", "modelProbe"]
}
```

`features` lists Connector-wide protocol features. It is optional; absent means
none, and the Server must ignore entries it does not know. Clients and the
Server decide whether to use a feature from this list, never from the
Connector version.

Discovery refreshes provider metadata. Instance lifecycle and session RPCs can
run immediately after a connection is established, including while discovery
is pending or after a discovery error. All scoped calls carry `runtime` and
`runtimeId`; discovery does not enable or disable those identities.

`RuntimeTypeDescriptor.configSchema` contains its own non-negative safe-integer
revision, JSON configuration schema, optional UI schema, defaults, and open
metadata. `available: false` requires a non-empty `reason`. Capability keys are
extensible strings with boolean availability values. `recommendationRank` is a
nullable non-negative safe integer; lower values are recommended first.

## Maturity and model connections

`RuntimeTypeDescriptor.maturity` is `experimental`, `beta` or `stable` and is
absent for stable runtimes that predate it. Clients show it next to the
lifecycle status, never instead of it, and must not infer it from whether a
start succeeded.

`RuntimeTypeDescriptor.modelConnection` declares how the runtime takes a model
connection from the unified configuration: the config field holding
`{baseUrl, apiKey}`, an optional model-list field, the API protocols it
speaks, optional run modes with the reason a mode is unsupported, the scope a
saved connection changes (`instance`, `session` or `native_global`), whether
models can be discovered or entered, and when a change applies (`immediate`,
`new_session` or `restart`). The capability has its own `maturity`. Absent or
`null` means the runtime takes no model connection; the Server must not guess
from the runtime type. A runtime that speaks more than one protocol also
receives `protocol` in the connection object, naming the protocol of
`baseUrl`. When the runtime has modes, `modeField` names the config field
that selects one.

An adapter rejects a connection it would not use during
`runtime.validateConfig` with code `model_connection_unsupported` instead of
saving and ignoring it. The `runtime.start` result (`runtime-start-result`)
may carry `modelConnection` with `state` `applied`, `failed`,
`managed_externally` or `not_configured`, plus the protocol, scope, mode,
reason, and an external owner such as a desktop app that keeps its own
settings for the sessions it owns. It never contains the API key. `applied`
means the runtime took the configuration, not that the endpoint was probed;
[Model probe](#model-probe) is how the Server confirms the endpoint answers.

## Independent failures

An invalid request, unavailable provider, or failed discovery affects that
request only. The connection remains usable and later requests can retry.
The Server forwards the explicit instance identity and reports errors returned
by the Connector. It does not infer support from a version field or reject a
snapshot because an earlier discovery did not complete. Read-only snapshots
can still use persisted state when the runtime is unavailable.

## Lifecycle

Every Runtime Control 2.1 lifecycle call carries both fields from
`RuntimeScope`. The Server and Connector must reject a request when `runtime`
does not match the immutable `runtimeType` associated with `runtimeId`.

| Method | Params schema | Additional fields |
| --- | --- | --- |
| `runtime.validateConfig` | `runtime-validate-config-params.schema.json` | `name`, `config`, `configRevision`, optional `operationId` + `switchRevision` |
| `runtime.start` | `runtime-start-params.schema.json` | `name`, `config`, `configRevision`, optional `operationId` + `switchRevision` |
| `runtime.stop` | `runtime-stop-params.schema.json` | None |
| `runtime.probeModelConnection` | `runtime-probe-model-connection-params.schema.json` | None; only with `modelProbe` |

`configRevision` and every revision in this contract are non-negative integers
no greater than `9007199254740991`. Millisecond timestamps fit this range and
remain safe when represented by JavaScript. Implementations must not increase
the bound or replace a timestamp revision with an unbounded content hash.

`RuntimeInstanceStatus.active` is desired state, so it may remain `true` while
`status` is `error`. An error status carries a structured error with a stable
`code` and human-readable `message`; optional provider details are preserved.
A non-error status may carry an optional `phase` (`code`, `message`, optional
`retryable`) describing the step the instance is in, for example
`{"code": "syncing", "message": "正在同步 DSH 会话…"}` while `status` is
`starting`. A phase is informational and never implies a fault; only `status`
decides whether the instance is usable. All timestamps use RFC 3339 date-time
strings.

## Switch fence

A Connector that lists `switchFence` in `features` fences Server-driven
configuration switches. The Server sends `operationId` (1 to 128 characters)
and `switchRevision` (a safe integer of at least 1, increasing per runtime
instance) together on `runtime.validateConfig` and `runtime.start` only to such
Connectors; sending one without the other is invalid. Requests without them
behave exactly as in 2.0 and never touch the fence.

The Connector keeps the last accepted switch per `runtimeId` on disk, so the
fence survives a Connector restart:

- A `switchRevision` lower than the accepted one fails with code
  `switch_revision_stale`.
- The accepted `switchRevision` with the same `operationId` is a retry: the
  request runs again and, because `runtime.start` is idempotent for an
  unchanged configuration, returns the current result.
- The accepted `switchRevision` with another `operationId` fails with
  `switch_revision_stale`.
- A higher `switchRevision` is accepted. `runtime.start` records it once the
  start finishes, whatever the outcome, so a replay of an earlier attempt can
  never undo it. `runtime.validateConfig` only checks the fence and never
  advances it.

`switch_revision_stale` is a request error like any other: the Connector
reports it as the RPC error code and leaves the running instance unchanged.

A fenced `runtime.start` is a hard replacement. Once the configuration
validates, the Connector stops the current instance (and with it every task
it runs), waits for the stop to finish, and creates a new instance from the
complete configuration in the request. It never keeps the running instance,
applies a change in place, or reuses its clients, even when the values are
unchanged or only the `modelField` setting differs. If the old instance cannot
be stopped, the start fails without creating a new one. The only exception is a
retry of the accepted switch (same `switchRevision` and `operationId`) that
finds the instance it started still running with the same values: that
returns the current result. Requests without the fence keep the 2.0
behavior, including the in-place `modelField` update.

The `runtime.start` result (`runtime-start-result`) carries:

- `configDigest`: lowercase hex SHA-256 of the model connection the instance
  actually loaded, or `null` when the runtime declares no `modelConnection`,
  the configuration has no connection (`baseUrl` absent), or the instance is
  not running a configuration (for example after a failed start). It is
  computed over the configuration values the Server sent, exactly like the
  Server's digest: `{"gateway": config[configField], "models":
  config[modelsField] or null}` serialized as JSON with sorted keys, no
  whitespace (`,` and `:` separators) and non-ASCII characters kept as UTF-8.
  The key only enters through this one-way hash.
- `instanceId`: identity of the Connector process. A restarted Connector
  reports a different value, so the Server can tell a reload from a
  configuration that was never applied.

A Connector that supports the fence may also add `configDigest` to
`runtime.statusChanged` notifications whenever the instance is running a
configuration with a model connection.

## Model probe

A Connector that lists `modelProbe` in `features` answers
`runtime.probeModelConnection` (`RuntimeScope` params). It sends one minimal
model request with the address, key, protocol and model of the configuration
the running instance was created with, never one from the request, and
replies with `runtime-probe-model-connection-result`:

- `probe.state` is `passed` when a valid model reply came back, `failed` when
  the request failed or the reply was not a model reply, and `skipped` when
  there is nothing to call: no model connection, no `modelConnection`
  capability, or no model the Connector can name (the configuration has no
  `modelsField` entries and no `modelField` setting).
- The model is the `modelField` setting when it is in the model list, else the
  first listed model. The protocol is the connection's `protocol`, else the
  runtime's first declared protocol.
- Requests follow the runtime's own conventions: `anthropic` posts to
  `{baseUrl}/v1/messages`, `openai_responses` to `{baseUrl}/responses` and
  `openai_chat` to `{baseUrl}/chat/completions`, with the key as a bearer
  token and at most 16 output tokens. The probe costs a few tokens.
- `probe.code` names the failure (`probe_unauthorized`, `probe_not_found`,
  `probe_rate_limited`, `probe_rejected`, `probe_upstream_error`,
  `probe_unreachable`, `probe_timeout`, `probe_invalid_response`) or why it
  was skipped (`not_configured`, `model_connection_unsupported`,
  `model_unknown`). `probe.message` is at most 300 characters and never
  contains the key.
- `configDigest` is the digest of the probed connection, computed like the
  start result's, so the Server can tell a probe of an older instance from one
  of the configuration it switched to.

An instance that is not running fails the request with
`runtime_unavailable`; the Connector waits at most 30 seconds for the model
endpoint.

## Validation

From the repository root, use the Server's locked Python environment:

```bash
cd server
uv run python ../contracts/runtime-control/2.1/validate.py
```

The validator checks every schema as Draft 2020-12, resolves contract-local
references, verifies valid and invalid fixtures, and confirms the SHA-256
digests recorded in `manifest.json`.

### Runtime model setting

The optional `modelConnection.modelField` names a top-level configuration
field holding `{modelId, effortId?}`: the model a new session uses when the
client does not choose one. The adapter writes it into that session's
selections when the session is created, so existing sessions keep their own
model. With a connection, `modelId` must be one of the models in
`modelsField`; without one it names a model from the runtime's own catalog.
A change to this field alone applies without restarting the runtime, and the
runtime publishes a model catalog whose matching item carries `default: true`.

## Channel reconciliation fencing

`channelReconcileFence` extends `switchFence` to stopping instances. Fenced stop accepts the same paired `operationId` and `switchRevision` as start. A stop consumes its revision persistently; starting with that same operation after a stop must rebuild. Older stops, starts and rollback operations must be rejected. Server assigns revisions monotonically per device, and persists managed instance IDs before dispatch so creation retries address the same instance. Channels require this feature; no unfenced fallback is permitted.
