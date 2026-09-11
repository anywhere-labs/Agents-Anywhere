# Connector lifecycle repair

Baseline: `06f1f241`. Work continues on `codex/session-pipeline-performance`.

Local replay against the real services and private SQLite databases confirmed:

- Deleting a connector with 500 queued source observations still ran all 500
  handlers, executed 4,500 SELECTs and formatted 500 tracebacks.
- After revocation and reconnection, an old queued `idle` event overwrote the
  new connection's `running` state and removed its active run.
- Clearing a runtime configuration deleted its sessions, but queued metadata
  recreated a session while that runtime remained stopped and unconfigured.
- A disconnect timeout after database deletion skipped buffer/cache cleanup;
  retrying deletion returned 404. The existing timeline sweeper reclaimed the
  orphaned pending write, but did not remove the runtime-state cache entry.
- A previously issued access token still performed a successful HTTP ingest
  after credential rotation. Tokens did not bind to the rotated credential.

Repair order:

1. Bind access tokens to the current credential and invalidate old connection
   work, including queued and running notification tasks.
2. Coordinate runtime cleanup with notification admission and session creation.
3. Make deletion cleanup retryable and preserve recovery of accepted writes.
4. Remove unchanged per-session scanner observations where complete inventory
   already records them; then optimize remaining repeated session work.

The baseline unchanged scan of 200 imported sessions executed 1,802 SQL
statements and constructed 600 SessionViews. Replaying only the existing
inventory begin/complete protocol executed three SQL statements, constructed no
SessionViews and produced identical persisted session rows. This is evidence
for the scanner change, not a production throughput estimate.

Normal connection shutdown must retain accepted timeline persistence/recovery.
Explicit deletion, revocation and replacement must prevent old work from
overwriting the new owner. Equal-version stored-content comparison remains
required. Process counts and a passing ordinary deletion test do not establish
these race guarantees; targeted interleaving and cross-worker tests are needed.

No production deployment is part of this repair checkpoint.


## Implemented behavior

The follow-up remains on `codex/session-pipeline-performance`.

- Access-token signatures are bound to the current long-lived credential hash.
  Rotation immediately invalidates already-issued HTTP and WebSocket tokens.
- HTTP admission, WebSocket registration, deletion and rotation share a Connector
  lifecycle lock across workers. WebSocket session lanes still run concurrently.
- A connection owns its notification consumer. Deletion/revocation cancels and
  awaits active handlers and queued lanes before releasing ownership. Cancellation
  while waiting for a concurrency slot also retires the pending counter.
- An ordinary disconnect with a valid lease stops RPC routing, reserves the lease
  while accepted work drains (up to 10 seconds), then releases it. Shutdown uses
  the same bounded drain. Expired/lost ownership cancels old work and triggers
  reconnect recovery; old cleanup cannot unregister a replacement connection.
- Both sides start the WebSocket reader before noncritical capability/recovery
  work. The Connector watches heartbeat failure and invalidates a failed sender,
  so the next notification cannot wait forever on an abandoned send queue.
- The Connector keeps failed HTTP batches across transient network errors,
  408/429/5xx and cancellation of the flush worker. Later live notifications and
  scanner snapshots do not overtake the fallback backlog. The waiting queue has
  capacity 1,024, plus a batch of up to 64; producers wait when it fills.
- RPC responses are bound to the connection generation that admitted the request.
  A late old response cannot be sent through a replacement socket.
- Reconnect requests event-runtime resynchronization and one recovery scan for
  polling runtimes, including sessions whose local marker is unchanged. Failed
  scans remain eligible for retry; active snapshots merge instead of replacing
  the live timeline. Ordinary subsequent scans return to the unchanged fast path.
- Connector deletion retains a revoked tombstone until external cleanup finishes.
  A bounded background sweep retries explicit pending deletions every 30 seconds,
  including after restart. It does not purge legacy revoked credentials.
- Runtime configuration deletion first stops the native runtime, then quiesces
  its notifications. A persisted runtime epoch fences old WebSocket jobs and HTTP
  fallback batches even after reconfiguration. The Connector binds that epoch to
  the immutable runtime host; reusing the same config with a new epoch creates a
  fresh native runtime. Other runtimes on the connection remain available.
- Runtime deletion attempts file cleanup before clearing terminal/cache state;
  pending timeline work is flushed before discard so a later database failure
  does not lose accepted content. The database and cleanup IDs remain retryable.

## Measured source-update improvements

The isolated headless replay uses real repository, ingest, queue and delete code
against temporary SQLite, with 200 unchanged imported sessions. The source state,
reason and observation origin are unchanged. Timing is a warm median of three
runs, not a production throughput estimate. SQL counts here exclude HTTP admission
and authentication, which run once per request/batch.

| Path | SQL statements | SessionView constructions | Event-loop CPU | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Original individual observations plus inventory | 1,802 | 600 | 639.263 ms | 1,298.615 ms |
| Individual observations with Server fast path | 602 | 0 | 181.523 ms | 415.670 ms |
| Connector uses inventory for unchanged sessions | 3 | 0 | 4.099 ms | 7.731 ms |

The final persisted session rows are identical in the replay. The single-session
fast path uses a conditional primary-key UPDATE only when availability, reason,
origin and identity match. It preserves newer timestamps, inventory scan tokens
for stale observations, revision counters and the user's archive choice. Actual
changes still use the existing fenced update and event publication.

For the 500-message deletion backlog, the original run made 4,500 SELECTs and
formatted 500 tracebacks (4,585,555 bytes). After the fix, the old backlog performs
zero SQL and emits zero tracebacks; all pending counters return to zero. The
actual delete/cancel operation in this replay used eight SQL statements and
16.372 ms wall time, including deletion of the 200 synthetic sessions.

Reproduce from the repository root with dev dependencies installed:

```sh
uv run --project server python server/scripts/benchmark_connector_lifecycle.py --output /tmp/connector-lifecycle.json
```

The script clears application database environment overrides and uses its own
private temporary database. It starts no listeners and contacts no native runtime.
The measured result is checked in beside this document.

## PostgreSQL verification

The same replay was then run against an isolated PostgreSQL 17.10 container,
using loopback TCP, temporary storage and the normal SQLAlchemy connection pool.
No application listener or native runtime was started. The controlled baseline
disables only the new no-change shortcut so the same service code takes its
existing full, revision-fenced path. The result is in
[connector-lifecycle-postgres-result.json](connector-lifecycle-postgres-result.json),
including the actual statements and EXPLAIN output.

| Path, 200 unchanged imported sessions | SQL statements | SessionViews | Event-loop CPU | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Individual observations through the full fenced path | 1,802 | 600 | 846.790 ms | 1,841.434 ms |
| Individual observations with the no-change shortcut | 602 | 0 | 198.947 ms | 473.898 ms |
| Inventory begin/complete without redundant individual observations | 3 | 0 | 4.749 ms | 10.150 ms |

All three paths produced identical persisted session rows. Timings are warm
medians of three local runs, with uncontrolled host load; event-loop CPU excludes
the database container's CPU. The deletion replay again applied zero SQL and
formatted zero tracebacks for the 500 obsolete queued messages. The actual
delete/cancel operation used eight SQL statements and 27.979 ms wall time.

EXPLAIN (ANALYZE, BUFFERS) on 10,000 synthetic rows confirmed:

- The conditional source UPDATE uses `sessions_pkey`, reads one candidate row
  and took 0.042 ms execution time in this warm run.
- Inventory begin marks every session belonging to this Connector/runtime;
  because the fixture contains only this runtime, a sequential scan is expected.
  Updating the 10,000 markers took 193.745 ms. Batching removes round trips and
  Python work; the database work still grows with inventory size.
- The inventory refresh UPDATE used the primary-key index for the 200 supplied
  session IDs. These are individual statement plans on a larger table, not an
  end-to-end benchmark of a complete 10,000-session inventory.

The PostgreSQL regression harness passed 21 lifecycle/inventory cases, including
credential rotation, failed cleanup followed by retry, pending deletion recovery,
old-runtime WebSocket/HTTP rejection and two real row-lock interleavings. The
latter observe the UPDATE waiting in `pg_stat_activity`, commit either a semantic
change or deletion in another transaction, and confirm that the waiting UPDATE
returns false without changing or recreating the row.

Reproduce with two disposable databases (the regression harness truncates its
test database; the benchmark requires empty application tables):

```sh
docker run -d --rm --name aa-session-check-pg -p 127.0.0.1:55439:5432 \
  --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER=aa_test -e POSTGRES_PASSWORD=aa_disposable_test \
  -e POSTGRES_DB=aa_session_perf postgres:17-alpine
docker exec aa-session-check-pg pg_isready -U aa_test -d aa_session_perf
docker exec aa-session-check-pg createdb -U aa_test aa_lifecycle_test
uv run --project server python server/scripts/benchmark_connector_lifecycle.py \
  --postgres-url postgresql+asyncpg://aa_test:aa_disposable_test@127.0.0.1:55439/aa_session_perf \
  --output /tmp/connector-lifecycle-postgres.json
uv run --project server python server/scripts/check_postgres_lifecycle.py \
  --postgres-url postgresql+asyncpg://aa_test:aa_disposable_test@127.0.0.1:55439/aa_lifecycle_test
docker stop aa-session-check-pg
```

Wait for `pg_isready` to report accepting connections before creating the second
database. The scripts reject non-loopback URLs and require the documented test
database prefixes. The regression adapter uses NullPool because legacy sync test
helpers open several event loops; performance measurements use the normal pool.

The completed local checks for this repair are Server: 854 passed / 16 skipped,
Connector: 766 passed, PostgreSQL lifecycle: 21 passed, Web: 265 passed and
`tsc --noEmit` passed. Two of the Server skips are the PostgreSQL-only row-lock
cases that were run successfully by the separate PostgreSQL harness. A later
focused run of 22 Server cases and 25 Connector supervisor cases also passed
after final style/test-assertion cleanup. The new scripts and modules pass Ruff;
existing findings elsewhere were not expanded into unrelated cleanup.

## Remaining limits and rollout

- Deploy the updated Connector before the Server runtime-epoch feature is used.
  The Server requires migration `v2_36` before workers accept traffic. Existing
  runtime epochs start at zero. Older Connector versions cannot restart a runtime
  with a nonzero epoch because they reject the additional control field.
- HTTP retry is at least once after a lost response. The in-memory outbox is not
  a durable exactly-once journal across process death. Native snapshots provide
  reconnect repair where the runtime can still supply the source data.
- Queue capacity above is a notification-count bound, not a global byte bound.
  The Server notification queue has no new hard capacity limit in this patch.
  Arbitrarily dropping a received WebSocket notification or blocking its RPC
  reader would require an acknowledgement/replay or flow-control contract.
- Capability publication still has per-session revision/presence/stamp work
  (803 SELECTs for 200 sessions in this replay). The shared capability index from
  the earlier commits remains; this patch does not remove its cross-worker
  consistency checks or change the Web invalidation protocol.
- Equal-version timeline content validation remains unchanged. The previously
  rejected conditional old-body-read prototypes are not adopted.
- The four-worker / one compute-child per worker ceiling remains unchanged.
  PostgreSQL query plans above validate the changed source/inventory paths.
  Real timeline-version distributions, production load and CPU saturation on
  the eight-core host have not been measured by this replay. It is not evidence
  for changing equal-version timeline validation. No production deployment is
  performed by these commits.
