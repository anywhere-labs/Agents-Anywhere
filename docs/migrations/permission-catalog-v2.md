# Permission Catalog v2 migration

This slice replaces the old runtime mode / permissionMode selector with one runtime-scoped permission catalog.

The old endpoint is removed from the v2 API:

```text
GET /api/v2/agents/{runtime}/modes
```

## Endpoint

```text
GET /api/v2/agents/{runtime}/permission-catalog
```

Response:

```json
{
  "catalog": {
    "runtime": "codex",
    "revision": 1,
    "permissions": [
      {
        "displayName": "Full access",
        "id": "fullAccess",
        "selectionId": "sel_permission_abc",
        "description": "Unrestricted access",
        "default": false
      }
    ]
  },
  "serverTime": "2026-07-20T10:00:00Z"
}
```

`selectionId` is identity-based and stable for a runtime permission identity. In this slice the Server derives it from the same identity rule used by the shared protocol helper; when Connector-published catalogs replace the seeded Server catalog, Connector should publish the same field instead of clients submitting native permission strings.

## Command payloads

New Session:

```json
{
  "connectorId": "conn_123",
  "runtime": "codex",
  "permissionSelectionId": "sel_permission_abc"
}
```

Send Message:

```json
{
  "content": "hello",
  "permissionSelectionId": "sel_permission_abc"
}
```

The Server resolves `permissionSelectionId` to the runtime-native permission value and serializes it to Connector command fields.

Legacy message field is rejected:

```text
mode
```

New Session also rejects permission choices inside:

```text
runtimeSettings.permissionMode
```

Use top-level `permissionSelectionId` instead.

## Session snapshot

`GET /api/v2/sessions/{sessionId}/snapshot` includes:

```json
{
  "catalogs": {
    "permission": {
      "runtime": "codex",
      "revision": 1,
      "permissions": []
    }
  }
}
```

Web should render the permission selector from this catalog and submit only `permissionSelectionId`.
