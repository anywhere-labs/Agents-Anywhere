# API v2 Namespace Migration

Agents Anywhere v2 serves product APIs under `/api/v2`.

The web UI may still be served from `/`, locale routes such as `/en`, and static assets such as `/_next/*`. Only API, SSE, and WebSocket endpoints move.

## Route Mapping

| Old root path | New v2 path |
| --- | --- |
| `/health` | `/api/v2/health` |
| `/auth/*` | `/api/v2/auth/*` |
| `/oauth/*` | `/api/v2/oauth/*` |
| `/.well-known/oauth-authorization-server` | `/api/v2/.well-known/oauth-authorization-server` |
| `/admin/*` | `/api/v2/admin/*` |
| `/agents/*` | `/api/v2/agents/*` |
| `/connectors/*` | `/api/v2/connectors/*` |
| `/pairing/*` | `/api/v2/pairing/*` |
| `/sessions/*` | `/api/v2/sessions/*` |
| `/connector/*` | `/api/v2/connector/*` |

## Web Migration

Keep `AGENTS_ANYWHERE_API` and `NEXT_PUBLIC_AGENTS_ANYWHERE_API` as the server origin, not the API namespace:

```bash
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

Do not set it to `http://127.0.0.1:8000/api/v2`.

`web-next/src/lib/api/client.ts` owns the namespace through `apiPath()`. Normal API calls should continue to pass product paths such as `/auth/login` or `/sessions`. The client turns them into `/api/v2/auth/login` and `/api/v2/sessions`.

Any Web code that builds a URL without `ApiClient` must call `apiPath()` explicitly. This applies to:

- SSE endpoints such as session events and dashboard events.
- WebSocket endpoints such as connector terminal streams.
- Direct browser links such as attachment open/download URLs.

The Next.js dev proxy rewrites `/api/v2/*` to the backend. New root-level API rewrites should not be added.

## Connector Migration

Connector config still stores the server origin:

```bash
uvx anywhere-cli configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

Do not store `/api/v2` in `serverUrl`.

`connector/connector/runtime.py` owns endpoint construction through `_api_v2_path()` and `_api_v2_url()`. Connector HTTP and WebSocket calls now target:

- `POST /api/v2/connector/auth`
- `POST /api/v2/connector/ingest`
- `WS /api/v2/connector/ws`
- `GET /api/v2/connector/sessions/{session_id}/attachments/{file_id}/content`
- `PUT /api/v2/connector/fs/transfers/{transfer_id}`
- `WS /api/v2/connector/terminals/{terminal_id}/relay`

Connector health probes use `/api/v2/health`.

Server-generated connector URLs, such as file transfer `uploadUrl` and runtime attachment `downloadUrl`, are also returned with `/api/v2` included. Connector URL helpers are idempotent for already-prefixed paths.

## Compatibility Rule

Do not add new root-level API routes in v2. If a route is product API, SSE, or WebSocket, mount it under `/api/v2`.
