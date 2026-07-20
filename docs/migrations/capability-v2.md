# Capability v2 migration

This migration introduces the first protocol-driven v2 slice: runtime capability discovery.

Compatibility with pre-v2 clients is not a design constraint for this slice. New clients should consume the v2 protocol endpoint directly and stop deriving feature availability from runtime names.

## Server

Connector ingest accepts:

```text
protocol.capabilitiesUpdated
```

Payload:

```json
{
  "revision": 2,
  "capabilities": [
    {
      "capabilityId": "session.interrupt",
      "version": "1",
      "scope": "runtime",
      "runtime": "codex",
      "sessionId": null,
      "supported": true,
      "available": true,
      "allowed": true,
      "unavailableReason": null,
      "parameters": {}
    }
  ]
}
```

The server validates the payload, stores it on the connector state, and rejects stale updates by revision. Equal revisions are idempotent and may overwrite with the same effective state.

Clients read the current capability snapshot with:

```text
GET /api/v2/connectors/{connectorId}/protocol/capabilities
```

Response:

```json
{
  "connectorId": "conn_123",
  "capabilitySet": {
    "revision": 2,
    "capabilities": []
  },
  "serverTime": "2026-07-20T10:00:00Z"
}
```

## Connector

After local runtime discovery, the connector publishes both:

```text
connector.capabilitiesUpdated
protocol.capabilitiesUpdated
```

`connector.capabilitiesUpdated` still carries the low-level discovery report used by server-side runtime attachment.

`protocol.capabilitiesUpdated` carries the product-facing capability set used by clients. The current first slice maps:

- Codex: `session.interrupt`, `session.steer`, `session.interaction.approval`, `runtime.config`, `catalog.model`, `catalog.permission`, `catalog.effort`
- Claude: `session.interrupt`, `runtime.config`, `catalog.model`, `catalog.permission`

Availability is derived from the runtime discovery report. If a runtime is not executable or its history source is unavailable, the capability remains supported but becomes unavailable with an `unavailableReason`.

## Web migration analysis

Web should add a capability client method:

```text
GET /api/v2/connectors/{connectorId}/protocol/capabilities
```

Recommended first integration point:

1. Fetch connector capability set when the dashboard/session context selects a connector.
2. Store capabilities by `connectorId` and `revision`.
3. Add a helper like `hasCapability(capabilityId, { runtime, scope })`.
4. Replace runtime-name checks for the first controls with capability checks:
   - interrupt button → `session.interrupt`
   - steer UI → `session.steer`
   - approval UI availability → `session.interaction.approval`
   - runtime settings entry point → `runtime.config`
   - model dropdown source readiness → `catalog.model`
   - permission dropdown source readiness → `catalog.permission`
   - effort dropdown source readiness → `catalog.effort`
5. If the endpoint returns revision `0` or no matching capability, treat the feature as unavailable and render a disabled or unsupported state.

Do not add legacy fallbacks for `/agents/*` behavior in new v2 UI paths. The goal is to make v2 features capability-driven from the start.

## Other clients

Android, iOS, and future clients should implement the same data path:

1. Fetch the connector capability snapshot over HTTP.
2. Cache by connector and revision.
3. Gate features by `capabilityId`, not by runtime name.
4. Treat unknown capability IDs as ignorable.
5. Treat missing required blocking capability as unsupported rather than silently proceeding.

The Web implementation should be reviewed first, then the same capability model can be copied into mobile client API models.
