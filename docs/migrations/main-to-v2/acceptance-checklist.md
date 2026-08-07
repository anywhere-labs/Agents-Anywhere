# v2 Migration Acceptance Checklist

Every required item must be evidenced for the release candidate. Mark an item
not applicable only with an owner and reason.

## Baseline and artifacts

- [ ] `main` source commit, v2 source commit, images, and client builds are recorded.
- [ ] The release diff was refreshed after the baseline commits in the overview.
- [ ] The migration reports contain no secret values.
- [ ] The v1 SQLite, file storage, Connector data, and deployment configuration backups were restored in a rehearsal.

## Data and infrastructure

- [ ] A disposable v1-to-v2 import completed with matching table row counts and SHA-256 digests.
- [ ] The final PostgreSQL target is new/empty before import.
- [ ] The final migration report is retained.
- [ ] Database revision is exactly `v2_7` and schema version is `2.7`.
- [ ] File payload counts and representative downloads match migrated metadata.
- [ ] Redis persistence is disabled and Redis is treated as ephemeral coordination.
- [ ] PostgreSQL and file-storage backup/restore procedures are tested.
- [ ] `/api/v2/health/ready` returns 200 with database and Redis checks `ok`.
- [ ] Starting Server against a stale schema fails readiness/startup as expected.

## Server API

- [ ] All product HTTP, SSE, and WebSocket routes use `/api/v2`.
- [ ] Configured Server URLs remain origins without `/api/v2`.
- [ ] Session create-and-start binds the first runtime events to the allocated platform session id.
- [ ] Existing-session messages omit model/permission fields.
- [ ] Model/permission changes use runtime selections.
- [ ] Commands do not fall back to normal messages on failure.
- [ ] Runtime notices respond through the session runtime notice route.
- [ ] Snapshot is used only for initial hydration or explicit recovery.
- [ ] Dashboard and session WebSocket tickets are single-use and scoped.

## Connector and runtimes

- [ ] A backed-up legacy Connector directory migrates to `~/.agents-anywhere` as documented.
- [ ] Obsolete SQLite sync state removal is accepted and resync succeeds.
- [ ] Connector config uses `statePath`/`AGENT_CONNECTOR_STATE_FILE` where overridden.
- [ ] Connector auth, ingest, WebSocket, attachment, transfer, and relay URLs use v2 helpers.
- [ ] Codex runs through the official SDK path without active app-server/IPC fallback.
- [ ] Claude reports its actual supported/unsupported capabilities.
- [ ] No active code imports `connector/_reference`.
- [ ] Runtime state, catalogs, notices, commands, and capabilities recover after Connector restart.
- [ ] Headless Connector start and shutdown are verified on every supported OS.

## Runtime coverage decision

- [ ] Production runtime inventory contains only v2-supported providers; or each unsupported dependency has an approved migration/blocker.
- [ ] Gemini ACP dependency is resolved.
- [ ] Cursor ACP dependency is resolved.
- [ ] Grok Build ACP dependency is resolved.
- [ ] CodeBuddy ACP dependency is resolved.

## Web

- [ ] `yarn typecheck` passes.
- [ ] `yarn protocol:check` passes with no stale generated files.
- [ ] Dashboard uses ticketed WebSocket snapshots without normal list polling.
- [ ] Session UI uses live runtime state and effective capabilities for actions.
- [ ] Selector reads are live and command filtering is client-side.
- [ ] Optimistic messages reconcile by `clientMessageId` without duplicates.
- [ ] Text, attachment-only, reasoning, tool, file-change, compact, and error timeline items render.

## Android

- [ ] Removed session routes (`/{id}`, `/state`, `/runtime-settings`, `/messages`, `/interrupt`, `/bulk-archive`) have no call sites.
- [ ] Removed runtime-management routes (`runtime-capabilities`, `agents/*/settings`) have no call sites.
- [ ] HTTP, SSE, WebSocket, attachment, and terminal URLs all use the v2 namespace once.
- [ ] Session live state, capabilities, notices, commands, and recovery are integration-tested.

## iOS

- [ ] Removed session routes (`/{id}`, `/{id}/read`, `/state`, `/runtime-settings`, `/messages`, `/interrupt`) have no call sites.
- [ ] Removed runtime-management/config routes have no call sites.
- [ ] HTTP, SSE, attachment, and direct URLs all use the v2 namespace once.
- [ ] Session live state, capabilities, notices, commands, and recovery are integration-tested.

## Cutover and rollback

- [ ] The maintenance/write-freeze procedure has an owner and tested duration.
- [ ] Server/Web are cut over together and Connector upgrades are batched.
- [ ] Monitoring covers removed-route traffic, Connector reconnects, Redis, database pools, recovery loops, and attachment failures.
- [ ] The rollback decision point and owner are recorded.
- [ ] The v1 stack remains runnable for the rollback window.
- [ ] Everyone understands that rollback returns to v1 backups; it does not downgrade the v2 database.
- [ ] Any writes accepted by v2 during the rollback window have an explicit reconciliation plan.
