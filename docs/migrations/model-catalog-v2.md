# Model Catalog v2 migration

This slice replaces separate model and effort reads with one runtime-scoped nested model catalog.

Compatibility with old `/agents/{runtime}/models` and `/agents/{runtime}/efforts` consumers is not a v2 requirement. New v2 clients should use `selectionId` only when saving or submitting a model choice.

The old split endpoints are removed from the v2 API:

```text
GET /api/v2/agents/{runtime}/models
GET /api/v2/agents/{runtime}/efforts
```

## Endpoint

```text
GET /api/v2/agents/{runtime}/model-catalog
```

Runtime scope is intentional: the catalog is used when creating a new session and when rendering runtime-level selectors. It is not inherently session-scoped.

Response:

```json
{
  "catalog": {
    "runtime": "codex",
    "revision": 1,
    "models": [
      {
        "displayName": "GPT-5.5",
        "id": "gpt-5.5",
        "selectionId": null,
        "reasoningItems": [
          {
            "displayName": "Extra high",
            "id": "xhigh",
            "fullModelId": "gpt-5.5",
            "selectionId": "sel_model_abc"
          }
        ]
      }
    ]
  },
  "serverTime": "2026-07-20T10:00:00Z"
}
```

## Selection IDs

Clients must submit one runtime-local `selectionId`.

Rules:

- If a model can run without reasoning, the model item has `selectionId`.
- If a model requires a reasoning choice, the model item has `selectionId: null`.
- Each reasoning item always has a `selectionId`.
- One `selectionId` resolves to both native values:
  - model id
  - reasoning / effort id, or `null`

Clients should not submit model id and reasoning id separately in v2 paths.

## Command payloads

New Session:

```json
{
  "connectorId": "conn_123",
  "runtime": "codex",
  "modelSelectionId": "sel_model_abc"
}
```

Send Message:

```json
{
  "content": "hello",
  "modelSelectionId": "sel_model_abc"
}
```

The server resolves `modelSelectionId` to native connector parameters:

```json
{
  "model": "gpt-5.5",
  "effort": "xhigh"
}
```

Legacy request fields are rejected in the v2 message endpoint:

```text
model
effort
mode
```

New Session also rejects model choices inside:

```text
runtimeSettings.model
runtimeSettings.effort
```

Use top-level `modelSelectionId` instead.

## Session snapshot

`GET /api/v2/sessions/{sessionId}/snapshot` now includes:

```json
{
  "catalogs": {
    "model": {
      "runtime": "codex",
      "revision": 1,
      "models": []
    }
  }
}
```

This lets the current session detail page render model selectors from the same catalog shape. New Session can call the runtime-scoped endpoint directly before a session exists.

## Web migration analysis

New Session:

1. Fetch `GET /api/v2/agents/{runtime}/model-catalog` after runtime selection.
2. Render model groups from `catalog.models`.
3. If `model.selectionId` exists, selecting the model is enough.
4. If `model.selectionId` is `null`, require selecting one `reasoningItems[]` entry.
5. Store and submit only the selected `selectionId`.

Session detail:

1. Read `snapshot.catalogs.model`.
2. Use `effectiveCapabilities["catalog.model"]` to decide whether to show the picker.
3. Render the picker from the nested catalog.
4. Submit only `selectionId` once the message/session command path supports v2 selections.

Do not derive the final native model or effort in Web. That resolution belongs in Server or Connector command handling.
