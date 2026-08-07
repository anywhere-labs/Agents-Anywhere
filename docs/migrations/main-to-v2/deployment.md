# Deployment and Cutover

Use a blue/green migration. The v2 database chain is forward-only and the v2
Connector performs a destructive local directory migration, so in-place
rollback is not the safe default.

## 1. Inventory

Record before changing anything:

- deployed `main` commit/image and every client version;
- v1 SQLite path from `AGENT_SERVER_DB` and its file size/hash;
- local or S3 file-storage configuration and object count;
- Server secret, public origin, CORS, OAuth, and setup configuration names;
- Connector ids, versions, hosts, config paths, and local data directories;
- active runtimes per Connector, especially ACP-backed runtimes;
- current session/timeline/user/connector row counts;
- available maintenance window and rollback decision owner.

Do not record secret values in the migration report.

## 2. Back up v1

Stop or quiesce writes before the final backup. Preserve independently:

1. the SQLite database;
2. file-storage payloads;
3. every Connector `~/.agent-server` directory or explicit config/data path;
4. deployment configuration and image references.

Validate that the SQLite backup opens before relying on it. Keep the v1 Server
and client artifacts runnable for the rollback window.

## 3. Rehearse

Provision disposable PostgreSQL 17 and Redis 8 instances. Run the import into an
empty rehearsal database:

```bash
cd server
uv sync
uv run python -m agent_server.infra.db.migrations rehearse-v1 \
  --source-sqlite /backup/agent-server.sqlite3 \
  --target-url postgresql+asyncpg://agents:password@db/agents_rehearsal \
  --report migration-report.json
```

Deploy v2 Server and Web against the rehearsal database, then upgrade at least
one disposable or backed-up Connector host. Complete the acceptance checklist.

Rehearsal is incomplete if production depends on an ACP runtime, an unmigrated
mobile client, or a file backend that was not copied and verified.

## 4. Prepare v2 infrastructure

The repository Compose deployment defines the intended order:

```bash
docker compose -f docker/docker-compose.postgres.yml up --build
```

It starts PostgreSQL, non-persistent Redis, a one-shot migrator, then Server.
For managed infrastructure, preserve the same ordering:

1. PostgreSQL ready;
2. Redis ready;
3. migration job succeeds;
4. Server starts and passes readiness;
5. Web/client traffic is enabled.

Required Server variables include:

```text
AGENT_SERVER_DB_URL
AGENT_SERVER_REDIS_URL
AGENT_SERVER_SECRET
```

Set pool, migration lock, file backend, public origin, and CORS variables for the
target environment. Use variable names/statuses in release records, never secret
values.

## 5. Final data cutover

1. Disable v1 writes and stop all v1 Server instances.
2. Take and identify the final SQLite and file-storage backups.
3. Create a new empty production PostgreSQL database.
4. Run the verified `rehearse-v1` import command against that empty target and
   save the final report.
5. Copy/verify file-storage payloads.
6. Confirm `schemaVersion=2.7 revision=v2_7`.
7. Start v2 Server and require `/api/v2/health/ready` to return 200.
8. Start the matching v2 Web deployment.

Do not start `main` against the PostgreSQL target and do not start v2 Server
against the old SQLite file.

## 6. Connector cutover

Upgrade Connectors in controlled batches:

1. Stop the old Connector.
2. Confirm its legacy directory backup exists.
3. Install the v2 package and start it once.
4. Inspect the migrated `~/.agents-anywhere` directory.
5. Confirm authentication and `/api/v2/connector/ws` connectivity.
6. Run discovery and activate expected native runtimes.
7. Verify one existing session sync and one new create-and-start flow.
8. Verify attachments, interrupt, selections, notices, and commands according
   to declared capabilities.

Do not upgrade a Connector that must provide an ACP runtime until a v2 provider
exists or the workload has moved.

## 7. Client cutover

Enable only clients that pass [Client migration](./clients.md). The v2 Web client
should be deployed with Server. Gate mobile distribution separately until its
removed-route inventory is empty.

Monitor:

- HTTP 404/405/422 counts under `/api/v2`;
- Connector authentication/reconnect loops;
- Redis availability and ticket/RPC routing errors;
- database pool saturation and migration/readiness failures;
- session refetch loops, duplicate timeline items, and optimistic-message leaks;
- runtime discovery/capability mismatches;
- attachment metadata and payload failures.

## Rollback

Rollback means returning traffic to the preserved v1 environment, not
downgrading the v2 database.

1. Stop v2 writes.
2. Record the v2 database and file-storage state for diagnosis; do not destroy
   it.
3. Route users back to the stopped-at-cutover v1 Server, SQLite database, file
   store, Web, Connectors, and compatible clients.
4. Restore Connector legacy directories from backup where first v2 start moved
   or deleted local files.
5. Reconcile any writes accepted by v2 during the cutover window before a later
   retry. There is no automatic reverse replication to v1.

If the business requires zero accepted-write loss during rollback, keep v2 in a
read-only validation phase until the release decision. The current migration
toolchain does not provide bidirectional replication.
