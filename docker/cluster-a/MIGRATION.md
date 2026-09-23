# Production migration (2026-09-14)

## Final state: 03:31 CST

The production database is restored and both application containers are running
healthy with three FastAPI workers each, bound only to 127.0.0.1:8000. All 28
restored table counts matched the stopped source exactly before application
startup: 1,142 users, 46,016 sessions, 7,892,198 Timeline rows. Schema v2_35,
index validity, constraint validation and application-role ownership passed.
Planner statistics were refreshed; temporary restore tuning was reverted.

The final attachment snapshot has 364 files / 728 objects / 791,259,962 bytes.
The previous 722 objects were reverified and six incremental objects copied.
Both nodes passed existing-user authentication using a short-lived diagnostic
token and read a historical attachment through the HTTP API, then fetched its
TOS redirect and checked content integrity. No user password was changed.

The original production signing secret is present on both workers and the
public origin is https://web.agents-anywhere.com. Bootstrap is false. The old
application is stopped with restart policy no. Its PostgreSQL, Redis, original
attachments and archive remain available. Original app configuration is saved
privately at /root/aa-cutover/old-container.json and old-runtime.env.

Routing, DNS and maintenance pages are user managed and were not changed during
this cutover. App readiness is distinct from completion of the public cutover.

The 9,340,304,027-byte pg_dump archive is at /root/aa-cutover/production.dump on
both the old server and DB node. Its SHA-256 is recorded in cutover.json. Restore
took 831 seconds. DB-node logs and exact count manifests live in /root/aa-cutover;
worker-1 attachment report is /root/aa-migration/reports/attachments-cutover.json.
Do not restart old writers after the new database accepts writes without first
planning reconciliation; the preserved old database is a frozen rollback source.

During source shutdown, Redis subscriber close raised ConnectionError after the
Timeline buffer drain. The pending set was confirmed empty, app workers exited,
and remaining event subprocesses were terminated. No new-node startup errors or
warnings were present at final verification.

## Earlier preparation snapshot

The remainder documents preparation before the final database cutover above.

Current state is recorded in migration-state.json. deployed.json describes the
historical alpha deployment, not the currently stopped application state.

Both alpha applications are stopped. The DB node now runs a fresh PostgreSQL
17.11 cluster, max_connections=300, using the original 1Panel Compose service
and new ./data17:/var/lib/postgresql/data mount. The database port is bound to
192.168.1.35:5432 (HOST_IP in the protected 1Panel .env); the existing
192.168.1.0/24 source firewall remains active. Both worker hosts authenticated
with the application role and confirmed PostgreSQL 17 and an empty schema. The old PostgreSQL 18 alpha
storage was removed. Compose configuration was backed up before replacement.
Keep the PostgreSQL 17 image and data mount when managing this custom service
through 1Panel; do not restore the obsolete PostgreSQL 18 template.

The target agents_anywhere database is empty and owned by agents_anywhere.
Its existing application password was retained. Alpha Redis DB 0 was cleared
only after both applications stopped. Neither worker should start before the
production database and authentication configuration are restored.

361 historical attachments (722 blob/metadata objects) were copied to
s3://alpha-1-agents-anywhere/web-production/attachments/ with their original
session/file IDs and exact bytes. Each uploaded object was downloaded again
and compared. Source and staging SHA-256 manifests matched. Worker-2 also
verified historical attachment reads and presigned HTTP download through the
application storage backend. Both worker environment files now use this prefix.
Old alpha objects under attachments/ are separate and were not overwritten.

The old production application and all source data remain intact. This is a
verified snapshot copy, not the final production cutover. Before restoring the
production DB and changing routing, stop old writers and drain pending Redis
Timeline writes, then reconcile a final attachment snapshot and restore the DB.
Preserve the production authentication secret/settings; do not carry alpha
login state into production. No production database dump or restore was run
in this preparation phase.

## Repeat or resume the attachment copy

Use a consistent source snapshot in a read-only mount, and reserve the target
prefix exclusively for this migration until verification completes. The script
never deletes source files and refuses conflicting destination content.
The default invocation validates only; add --apply to upload and verify.

```sh
uv run --no-sync python /migration/migrate_attachments.py \
  --source /migration/old-attachments \
  --bucket alpha-1-agents-anywhere \
  --prefix web-production/attachments \
  --report /reports/attachments-upload.json --apply
```

Run inside the server image with the AGENT_SERVER_FILES_S3_* environment from
the protected worker .env. Do not place credentials, file inventories, or user
attachment contents in Git. The operational snapshot, log and report reside
under /root/aa-migration on worker-1; preserve them until final cutover validation.

Validation of the migration tool covered corrupt-source rejection, successful
upload/readback, idempotent skip of identical objects, and conflict refusal.
