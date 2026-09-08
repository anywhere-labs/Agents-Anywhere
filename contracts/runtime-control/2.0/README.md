# Runtime Control 2.0 Contract

Runtime Control is the Server-to-Connector RPC contract for discovering and
operating runtime types and named runtime instances. Server and Connector are
released together and use one protocol. Runtime requests never negotiate versions
or depend on a persisted compatibility mode.

The files under this directory are the source of truth for Runtime Control 2.0.
`contracts/protocol/1.0` is frozen and must not be changed to implement named
runtime instances.

## Identity

Runtime Control 2.0 keeps provider and instance identity separate:

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
least two, or `null` when the provider does not impose a fixed count. Resource
claims may still prevent two otherwise valid instances from using the same
native source.

Implementation models and generated client types must use the exact
`single`/`multiple` tokens; `singleton` is not a Runtime Control 2.0 value.

## Discovery

The Server calls `runtime.discover` with an empty parameter object:

```json
{}
```

The Connector returns provider descriptors:

```json
{
  "runtimeTypes": []
}
```

Discovery refreshes provider metadata. Instance lifecycle and session RPCs can
run immediately after a connection is established, including while discovery
is pending or after a discovery error. All scoped calls carry `runtime` and
`runtimeId`; discovery does not enable or disable those identities.

`RuntimeTypeDescriptor.configSchema` contains its own non-negative safe-integer
revision, JSON configuration schema, optional UI schema, defaults, and open
metadata. `available: false` requires a non-empty `reason`. Capability keys are
extensible strings with boolean availability values. `recommendationRank` is a
nullable non-negative safe integer; lower values are recommended first.

## Independent failures

An invalid request, unavailable provider, or failed discovery affects that
request only. The connection remains usable and later requests can retry.
The Server forwards the explicit instance identity and reports errors returned
by the Connector. It does not infer support from a version field or reject a
snapshot because an earlier discovery did not complete. Read-only snapshots
can still use persisted state when the runtime is unavailable.

## Lifecycle

Every Runtime Control 2.0 lifecycle call carries both fields from
`RuntimeScope`. The Server and Connector must reject a request when `runtime`
does not match the immutable `runtimeType` associated with `runtimeId`.

| Method | Params schema | Additional fields |
| --- | --- | --- |
| `runtime.validateConfig` | `runtime-validate-config-params.schema.json` | `name`, `config`, `configRevision` |
| `runtime.start` | `runtime-start-params.schema.json` | `name`, `config`, `configRevision` |
| `runtime.stop` | `runtime-stop-params.schema.json` | None |

`configRevision` and every revision in this contract are non-negative integers
no greater than `9007199254740991`. Millisecond timestamps fit this range and
remain safe when represented by JavaScript. Implementations must not increase
the bound or replace a timestamp revision with an unbounded content hash.

`RuntimeInstanceStatus.active` is desired state, so it may remain `true` while
`status` is `error`. An error status carries a structured error with a stable
`code` and human-readable `message`; optional provider details are preserved.
All timestamps use RFC 3339 date-time strings.

## Validation

From the repository root, use the Server's locked Python environment:

```bash
cd server
uv run python ../contracts/runtime-control/2.0/validate.py
```

The validator checks every schema as Draft 2020-12, resolves contract-local
references, verifies valid and invalid fixtures, and confirms the SHA-256
digests recorded in `manifest.json`.
