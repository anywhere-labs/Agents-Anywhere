# Main to v2 Migration

Status: code-backed migration guide for the current v2 development baseline.

This guide describes how to move a deployment and its clients from `main` to
the new v2 architecture. It is not a changelog and it does not treat target-only
documents as implemented behavior.

## Comparison baseline

The initial audit for this guide compared:

| Role | Branch | Audited commit |
| --- | --- | --- |
| Existing deployment | `main` | `73fc99e97efe305ba2fc8caf5c4f4f22f4cc9bf7` |
| v2 implementation | `v2-connector-refactor` | `a9f0b121249eff5d022fc04aec16723929ce7f29` |

Refresh both branch heads and re-run the acceptance checklist before a release.
The commits above identify the facts used while writing this guide; they are not
release tags.

## Migration documents

1. [Server and data](./server-and-data.md) covers the API namespace, PostgreSQL
   schema chain, v1 SQLite import, Redis ownership, and session API changes.
2. [Connector and runtimes](./connector-and-runtimes.md) covers the new runtime
   protocol, local state migration, supported providers, and removed adapters.
3. [Clients](./clients.md) covers Web, Android, iOS, realtime, and payload
   migration.
4. [Deployment](./deployment.md) gives the ordered rehearsal, cutover, and
   rollback procedure.
5. [Acceptance checklist](./acceptance-checklist.md) defines the release gates.

## Breaking changes at a glance

| Area | `main` | v2 | Required action |
| --- | --- | --- | --- |
| Product API | Root paths such as `/sessions` | `/api/v2/*` | Upgrade every HTTP, SSE, and WebSocket URL builder. Keep configured Server URLs as origins. |
| Server database | SQLite selected by `AGENT_SERVER_DB` | PostgreSQL selected by `AGENT_SERVER_DB_URL` | Rehearse and execute the verified v1 import into an empty PostgreSQL database. |
| Schema lifecycle | Server initializes SQLite on startup | Explicit Alembic chain, exact revision `v2_7` required | Run the migrator before starting Server; do not rely on startup mutation. |
| Distributed coordination | Process-local presence and RPC | Redis for leases, Pub/Sub, tickets, locks, and relays | Provision Redis, but do not treat it as durable storage. |
| Connector runtime API | Dict-shaped `Adapter` and `notification_sink` | `RuntimeProvider`, `AgentRuntime`, and `RuntimeHostClient` | Port runtime integrations to the typed, two-direction protocol. |
| Codex | CLI/app-server and IPC-oriented adapter | Official `openai-codex` SDK path | Remove app-server/IPC configuration assumptions. |
| Runtime support | Codex, Claude, and built-in ACP manifests | Native Codex and Claude providers | Treat ACP-backed Gemini, Cursor, Grok Build, and CodeBuddy as unavailable until a v2 provider is implemented. |
| Connector local data | `~/.agent-server`, SQLite sync state | `~/.agents-anywhere`, atomic JSON sync state | Back up the old directory before first v2 start; let the one-time migration run. |
| Session reads | Combined `/state` response | `meta`, `timeline`, `runtime/*`, and recovery snapshot | Update clients by ownership boundary. |
| Session actions | `/messages`, `/interrupt`, approval resolve routes | `/runtime/messages`, `/runtime/interrupt`, `/runtime/notices/*` | Replace old action endpoints and payloads. |
| Realtime | Dashboard SSE plus polling; session SSE | Ticketed dashboard/session WebSockets plus explicit recovery | Use tickets, process scoped events, and fetch snapshots only for hydration or required recovery. |
| Rollback | Reuse the same SQLite deployment | Forward-only v2 schema | Preserve the v1 stack and SQLite backup for blue/green rollback. Never point `main` at the v2 database. |

## Compatibility policy

A mixed `main`/v2 stack is not a supported steady state.

- A `main` client does not add `/api/v2` and cannot use the v2 Server.
- Adding only `/api/v2` is insufficient because several session and runtime
  routes changed shape or were removed.
- The v2 Connector expects v2 connector endpoints and runtime RPC methods.
- The v2 Web client is the reference client for the current v2 session API.
- Android and iOS currently add the v2 namespace but still contain old session
  and runtime-management calls. They are not release-compatible until the
  client migration checklist is complete.
- ACP runtimes available on `main` do not have an active provider in this v2
  baseline.

## Recommended order

1. Inventory the `main` database, files, Connector data, runtime usage, and all
   deployed client versions.
2. Back up the v1 SQLite file, file storage, Connector data directories, and
   deployment configuration.
3. Rehearse the SQLite-to-PostgreSQL import against a disposable database and
   retain the generated verification report.
4. Validate the v2 Server, Web, and Connector together in a staging environment.
5. Resolve every blocked item in the acceptance checklist, especially mobile
   session APIs and any ACP runtime dependency.
6. Stop v1 writes, perform the final import into a new empty PostgreSQL database,
   and deploy the v2 Server and Web as one cutover.
7. Upgrade Connectors, verify live runtime discovery, then release compatible
   clients.

Do not remove the v1 environment until the rollback window has closed.
