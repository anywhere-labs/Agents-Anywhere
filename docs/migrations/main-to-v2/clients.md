# Client Migration

All clients must migrate both URL construction and session behavior. Adding the
`/api/v2` prefix alone does not make a `main` client compatible.

## Shared URL rule

Store only the Server origin, then apply one idempotent namespace helper:

```text
apiPath("/sessions") -> "/api/v2/sessions"
apiPath("/api/v2/sessions") -> "/api/v2/sessions"
```

Apply the same rule to direct browser links, SSE URLs, and WebSocket paths. Do
not apply it to frontend pages or static assets.

## Session data boundaries

Clients should load data by owner:

| UI need | v2 source |
| --- | --- |
| Title, archive/read state, runtime identity, Connector presence | `GET /api/v2/sessions/{id}/meta` or session list |
| Durable conversation history | `GET /api/v2/sessions/{id}/timeline` |
| Initial aggregate hydration or explicit recovery | `GET /api/v2/sessions/{id}/snapshot` |
| Busy/error status and selections | `GET /api/v2/sessions/{id}/runtime/state` |
| Action availability | `GET /api/v2/sessions/{id}/runtime/capabilities` |
| Existing-session selectors | Session runtime catalog endpoints |
| New-session selectors | Connector runtime catalog endpoints |
| Approval/input UI | `GET /api/v2/sessions/{id}/runtime/notices` |
| Slash commands | `GET /api/v2/sessions/{id}/runtime/commands` |

Do not restore removed state by merging old `session.status`, persisted catalog,
or persisted notice fields over a live runtime response.

## Action migration

| User action | v2 request |
| --- | --- |
| Create a new task and send first message | `POST /api/v2/sessions/create-and-start` |
| Bind/import an existing external session | `POST /api/v2/sessions` |
| Change model/permission | `PATCH /api/v2/sessions/{id}/runtime/selections` |
| Send message | `POST /api/v2/sessions/{id}/runtime/messages` |
| Steer active turn | `POST /api/v2/sessions/{id}/runtime/steer` |
| Interrupt | `POST /api/v2/sessions/{id}/runtime/interrupt` |
| Execute command | `POST /api/v2/sessions/{id}/runtime/commands` |
| Respond to notice | `POST /api/v2/sessions/{id}/runtime/notices/{noticeId}/respond` |
| Mark read | `POST /api/v2/sessions/read` with `string[]` body |
| Archive/unarchive | `POST /api/v2/sessions/archive` or `/unarchive` with `string[]` body |

Existing-session message payloads contain content, attachments, and an optional
`clientMessageId`. They do not contain model or permission selection ids.

The client should use `clientMessageId` to reconcile optimistic user messages
with runtime echoes. Attachment-only inputs must remain valid; the UI must not
inject display notes into message text as a transport mechanism.

## Selectors and commands

Read model and permission catalogs when the selector opens. A locally remembered
selection is a hint only; validate it against the live catalog and fall back to
an enabled option when necessary.

When command mode opens, read the full command list and fuzzy-match locally. If
the command read or execution fails, keep the input in command mode and show the
error. Never send the slash-prefixed input as a normal message fallback.

## Realtime migration

### Dashboard

1. Request a single-use ticket from `POST /api/v2/ws-ticket` for the dashboard
   scope.
2. Connect to `WS /api/v2/dashboard/ws?ticket=...`.
3. Apply the initial connector/session snapshot.
4. Reconnect with a new ticket after disconnect.

Do not retain the `main` dashboard SSE plus 30-second list polling as the normal
v2 lifecycle.

### Session

Use the ticketed session WebSocket for live meta, timeline, runtime state,
notice, and capability events. Keep `GET /events` for durable event recovery.

Snapshot reads are allowed for:

- initial hydration;
- explicit `snapshotRequired`/refetch recovery;
- user-requested refresh.

They are not a polling API and should not run after every message, command,
interaction, or sequence gap.

## Web status

`web-next` is the reference v2 client in this baseline. It already uses the v2
namespace, create-and-start, runtime-scoped session actions, live catalogs and
commands, optimistic `clientMessageId` reconciliation, and dashboard WebSocket
lifecycle.

Before release, still run:

```bash
cd web-next
yarn typecheck
yarn protocol:check
```

`protocol:check` is a release gate. Generated TypeScript must match the JSON
schemas under `contracts/protocol/1.0`.

## Android status

Android has an `apiPath()` helper and namespaces HTTP/SSE/WebSocket URLs, but the
current code still calls several removed `main` routes, including:

- `/sessions/{id}` patch;
- `/sessions/bulk-archive`;
- `/sessions/{id}/state`;
- `/sessions/{id}/runtime-settings`;
- `/sessions/{id}/messages` and `/interrupt`;
- `/connectors/{id}/runtime-capabilities/*`;
- `/connectors/{id}/agents/{runtime}/settings`.

It also removes ACP runtimes from the add-agent UI. Android is not v2-compatible
until those calls move to the API described above and its session event/rendering
behavior passes the acceptance checklist.

## iOS status

iOS also applies `/api/v2`, but currently retains removed `main` calls such as:

- `/sessions/{id}`, `/read`, and `/state`;
- `/sessions/{id}/runtime-settings`;
- `/sessions/{id}/messages` and `/interrupt`;
- `/connectors/{id}/agents/{runtime}/settings`;
- `/agents/{runtime}/config-schema` as the old configuration flow.

iOS is not v2-compatible until those routes, payloads, live-state ownership, and
realtime handling are migrated. Namespace-only changes must not be presented as
client migration completion.

## Client release rule

Do not release a client as v2-compatible until an automated route inventory or
integration test proves that it no longer calls removed `main` endpoints. Test
HTTP, SSE, WebSocket, attachment open/download URLs, and terminal streams; the
shared request wrapper does not cover every direct URL builder.
