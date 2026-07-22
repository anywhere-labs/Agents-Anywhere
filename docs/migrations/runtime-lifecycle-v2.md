# Runtime discovery, configuration, and lifecycle migration

This document covers the v2 device-runtime feature as one end-to-end migration. It applies to Web and to any other client that configures a Connector device.

There is no compatibility layer for the former Agent settings and runtime-capability APIs. Clients must migrate the complete feature.

## Product boundary

Runtime configuration answers only how the Connector discovers and starts a local Agent Runtime. Typical fields are:

- executable path;
- environment-variable overrides;
- future Runtime-specific boot options.

Model, reasoning, permission, and sandbox/approval selections are not Runtime configuration. New Session obtains those choices from the Runtime catalogs and submits only `modelSelectionId` and `permissionSelectionId`.

## Lifecycle and ownership

1. When a Connector WebSocket connects, the Connector reports every Runtime provider it knows, its current discovery result, JSON Schema, UI Schema, and current process status.
2. Server caches the latest discovery and Schema and persists the user's configuration and `active` flag.
3. Opening a Device page reads the Server cache. It does not start discovery.
4. Pressing Refresh synchronously asks the connected Connector to discover again and returns the resulting list.
5. Saving configuration is validated by Web, Server, and Connector. Connector also validates the executable against the current local device.
6. An active Runtime is started by an explicit Server command. Connector never starts a Runtime merely because it was discovered.
7. Activating starts it, deactivating stops it, editing an active configuration restarts it, and deleting configuration stops it before clearing the persisted configuration.
8. Stopping a Runtime settles its active Sessions and cancels blocking Interactions so stale approval cards cannot remain.

The Connector is the source of truth for `starting`, `running`, `stopping`, `stopped`, and `error`. The Server is the source of truth for the desired `active` flag and persisted configuration.

## HTTP API

All paths use `/api/v2`.

| Purpose | Request |
| --- | --- |
| Read cached Runtime inventory | `GET /connectors/{connectorId}/runtimes` |
| Explicitly refresh discovery | `POST /connectors/{connectorId}/runtimes/discover` |
| Validate and save configuration | `PUT /connectors/{connectorId}/runtimes/{runtimeId}/config` with `{ "config": {} }` |
| Activate or deactivate | `PUT /connectors/{connectorId}/runtimes/{runtimeId}/active` with `{ "active": true }` |
| Stop and delete configuration | `DELETE /connectors/{connectorId}/runtimes/{runtimeId}/config` |

`GET` and `POST discover` return:

```json
{
  "connectorId": "conn_123",
  "runtimes": [],
  "serverTime": "2026-07-22T10:00:00Z"
}
```

Mutation endpoints return the updated Runtime item directly:

```json
{
  "connectorId": "conn_123",
  "runtimeId": "codex",
  "runtimeType": "codex",
  "displayName": "Codex",
  "present": true,
  "configured": true,
  "active": true,
  "status": "running",
  "discovery": {},
  "schema": {},
  "uiSchema": {},
  "config": {},
  "error": null,
  "lastDiscoveredAt": "2026-07-22T10:00:00Z",
  "updatedAt": "2026-07-22T10:00:00Z"
}
```

Important semantics:

- `config: null` and `configured: false` mean unconfigured.
- `config: {}` and `configured: true` mean configured with current dynamic defaults.
- There is no config or Schema revision in this feature. The Server validates against its cached Schema and the Connector validates again against its current Schema and local environment.
- Discovery changing a default does not overwrite a user override. Reset all defaults submits `{}`.
- `active: true` is desired state; `status: running` is observed state.
- Deleting Runtime configuration does not delete Sessions, Timeline history, or the local Agent installation.

## Web migration

Remove the former data sources:

- `connector.runtimeCapabilities`;
- `/agents/{runtime}/config-schema`;
- `/connectors/{connectorId}/agents/{runtime}/settings`;
- `/connectors/{connectorId}/runtime-capabilities/*`;
- fixed model/effort/permission fields inside Runtime config.

The Device page renders two groups:

1. Configured: `configured === true`, including inactive and error states.
2. Discovered, not configured: `present === true && configured === false`.

Use one Schema-driven modal Dialog on desktop and mobile. Do not use a Drawer for input-heavy configuration. Render fields using `schema.properties`, use `uiSchema.order` for ordering, and use UI components only from an allowlist. The initial generic renderer supports primitive fields, enum, JSON fallback, and the `keyValue` environment editor. Unknown fields remain renderable without a Runtime-specific page.

The only reset action is “Reset all defaults,” which produces `{}`. A default executable path is displayed as a placeholder and is not copied into the override until the user changes it.

The New Session page separately fetches Runtime lists for online Connectors. A Runtime is selectable only when:

```text
configured && active && status == running
```

After selection, fetch model and permission catalogs from the Connector-backed catalog endpoints. Persist the latest selection IDs per device and Runtime in client storage. Never reconstruct or submit Runtime-native model, reasoning, sandbox, or approval values.

Runtime mutations publish dashboard change events. Web should refetch the cached Runtime list when its existing dashboard refresh path runs. A dedicated Runtime WebSocket model is not required for this phase.

## Other client migration

Android, iOS, and other clients should use the same grouping, status, and mutation semantics. They may implement a smaller Schema component allowlist, but must:

- show a clear unsupported-field error instead of dropping required input;
- send the entire override object in `config`;
- treat `{}` as a valid configured value;
- wait for the mutation response instead of assuming a Runtime started;
- keep Sessions and Timeline history after Runtime configuration deletion;
- obtain New Session model and permission choices from catalogs and submit selection IDs only.

## Adding another Runtime

Runtime-specific work belongs in a Connector `RuntimeProvider`. A provider supplies:

- stable `runtime_id`, `runtime_type`, and display name;
- discovery and executable probing;
- dynamic JSON Schema and UI Schema;
- config validation and merge with current local defaults;
- adapter construction and shutdown;
- protocol capabilities and catalogs.

Server and Web do not need a new endpoint or page for a new provider. When a new field uses an existing Schema/UI component, no Web change is needed. A genuinely new interaction control requires adding one generic UI-Schema component renderer, not a Runtime-name branch.

Environment configuration uses `Record<string, string | null>`: a string overrides an inherited variable and `null` removes it. Connector rejects internal `AGENT_CONNECTOR_*` and `AGENT_SERVER_*` variables, never logs the submitted environment, and keeps credentials on the Connector device.
