# v2 Domain Contract Plan

This plan starts from schema revision `v2_2` and the distributed infrastructure
merged into `v2` at commit `632d2d5`. It keeps PostgreSQL as the durable source
of truth and Redis as an ephemeral coordination and invalidation layer. It does
not introduce a persistent event log.

## Current Contract Boundaries

| Contract | Current authority | Duplicated or transitional state |
| --- | --- | --- |
| Session | `server/agent_server/core/models.py` | Connector legacy statuses are mapped at ingest; Android and iOS still consume `waiting_approval` and `error` as session states. |
| Capability | `server/agent_server/core/protocol.py` and `services/effective_capabilities.py` | Connector repeats the Pydantic wire model; Web stores `effectiveCapabilities` but controls the composer from session status. |
| Catalog | Server protocol models plus Connector catalog builders | Web repeats TypeScript types and selection lookup rules. |
| Interaction | Server `Notice` | Mobile compatibility approvals are projected from notices; timeline items retain `waiting_approval` until mobile migration. |
| Event | `ProtocolEventEnvelope` and database-derived recovery responses | Redis notifications and WebSocket delivery are ephemeral; recovery is reconstructed from durable state rather than an event log. |

The external v2 session state is already limited to `idle`, `pending`,
`running`, `stopping`, and `blocked`. Runtime-specific values may exist only at
the Connector adapter boundary and must be mapped before entering the Server
domain.

## Ordered Implementation

### 1. Capability decision vertical slice

- Define shared Server helpers for looking up well-known capabilities and
  deciding whether they are usable (`supported && available && allowed`).
- Make Web send, interrupt, and catalog controls consume
  `effectiveCapabilities` instead of reimplementing session-state rules.
- Preserve session status for presentation only; the Server remains the
  authority that derives availability and unavailable reasons.
- Add Server unit tests and Web typecheck/build coverage for supported,
  unavailable, disallowed, and missing capabilities.
- Do not change the database schema.

Completion means the session composer has no direct status-based authorization
logic for send or interrupt. A missing capability fails closed after a snapshot
has loaded; optimistic pre-snapshot state remains disabled.

### 2. Canonical protocol schema and compatibility tests

- Publish the Server Pydantic wire models as versioned JSON Schema artifacts.
- Validate Connector payload fixtures and generated TypeScript definitions
  against the same artifacts.
- Separate extensible identifiers from well-known identifiers: unknown
  capability and catalog metadata must round-trip without being treated as
  usable by default.
- Keep protocol version `1.0` until a wire-incompatible field is required.

### 3. Interaction as the external authority

- Define an application-level Interaction state machine independent of HTTP and
  Runtime adapter payloads.
- Keep Approval parsing at the Connector ingress boundary and project it into
  Interaction in one service.
- Move approval response orchestration behind an Interaction port.
- Remove `approvals` from new snapshot consumers only after Web and Connector
  compatibility tests pass.

The existing Approval tables and snapshot field remain during this phase. This
avoids combining a behavior refactor with a destructive migration.

### 4. Session state transition service

- Centralize allowed session transitions and derived status calculation.
- Restrict `waiting_approval` and runtime `error` mapping to adapter input.
- Make Interaction blocking and active-run state explicit inputs to the
  transition service.
- Replace scattered status comparisons in services with transition queries.

### 5. Catalog contract

- Define model, reasoning, and permission catalog invariants and selection
  validation in the domain layer.
- Treat catalogs as revisioned Runtime data; sessions retain only stable
  selection IDs.
- Make Web selectors capability-gated and catalog-driven, with no fallback to
  legacy runtime settings.

### 6. Event and recovery contract

- Define cursor as a durable-state revision token, not a persisted event
  offset.
- Publish Redis invalidations only after the database transaction commits.
- Require recovery to return either a deterministic delta or
  `snapshotRequired`; never infer successful replay from Pub/Sub delivery.
- Add multi-instance gap, reconnect, and snapshot fallback tests.

### 7. Legacy storage removal

Completed in schema revision `v2_3`.

- Introduce schema revision `v2_3` only when the durable Approval/legacy columns
  are actually changed.
- Preserve required v1 source data in `legacy_import_archive` before contract
  tables or columns are removed.
- Test `v1_legacy -> v2_0 -> v2_1 -> v2_2 -> v2_3` and every adjacent upgrade.
- Require Connector approval prompts to use `notice.upsert`; reject
  `approval.requested` at Server ingress.

### 8. Mobile migration

- Move Android and iOS to the five-state session model, snapshot, Interaction,
  Catalog, and Capability contracts.
- Remove mobile handling of `waiting_approval` and `error` as session states.
- Remove Server compatibility output only after both clients consume the new
  contracts.

## Versioning Rules

- Application SemVer and database schema versions remain independent.
- A behavior-only or wire-compatible domain refactor does not bump the database
  version.
- Every durable schema or data migration adds exactly one Alembic revision.
- Wire-incompatible changes require a protocol-version decision and explicit
  compatibility tests; an API route prefix alone is not a protocol version.
