# Runtime Control 2.0 Contract

Runtime Control is the Server-to-Connector RPC contract for discovering and
operating runtime types and named runtime instances. It is versioned separately
from the Agent Runtime Protocol, application releases, and database revisions.

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
- Provider categories such as `local-service` belong in `metadata`; they are
  not valid substitutes for `runtime` or `runtimeType`.

After an instance is created, implementations must reject changes to its
`runtimeId` or `runtimeType`. Renaming an instance does not change its session
namespace and does not, by itself, restart the runtime.

`instancePolicy` is `single` or `multiple`. A single-instance provider has
`maxInstances: 1`. A multiple-instance provider has an integer limit of at
least two, or `null` when the provider does not impose a fixed count. Resource
claims may still prevent two otherwise valid instances from using the same
native source.

## Discovery

A 2.0-capable Server calls `runtime.discover` with params matching
`runtime-discover-request.schema.json`:

```json
{
  "supportedControlVersions": ["2.0", "1.0"]
}
```

The list is in preference order and must contain `2.0` for the request to be a
Runtime Control 2.0 document. A Connector selecting 2.0 returns exactly the
shape in `runtime-discover-response.schema.json`:

```json
{
  "selectedControlVersion": "2.0",
  "runtimeTypes": []
}
```

`RuntimeTypeDescriptor.configSchema` contains its own non-negative safe-integer
revision, JSON configuration schema, optional UI schema, defaults, and open
metadata. `available: false` requires a non-empty `reason`. Capability keys are
extensible strings with boolean availability values.

## V1 Fallback

An empty discover request and a legacy `{ "runtimes": [...] }` result are v1
fallback messages only. They are intentionally absent from the 2.0 schemas and
fixtures, and must never be accepted as 2.0 after negotiation.

| Server | Connector | Discover behavior | Named instances |
| --- | --- | --- | --- |
| New | New | Server offers versions; Connector returns `selectedControlVersion: "2.0"` and `runtimeTypes`. | Enabled after 2.0 is selected. |
| New | Legacy | Legacy Connector ignores the offer and returns `{ "runtimes": [...] }`; Server records v1. | Disabled; expose one compatibility instance per provider with `runtimeId == runtime`. |
| Legacy | New | Legacy Server sends empty params; new Connector returns the exact legacy `{ "runtimes": [...] }` shape. | Disabled; Connector uses v1 lifecycle semantics. |
| Legacy | Legacy | Existing empty-request and legacy-result exchange. | Not supported. |

When a Connector connection is operating in v1, the Server must not send an
`rti_*` identifier. Attempts to create or operate a named instance must fail
with a stable `runtime_instances_unsupported` error instead of being translated
silently.

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
