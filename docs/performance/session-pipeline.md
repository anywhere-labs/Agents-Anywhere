# Session pipeline performance

Baseline: `0601e668` (the production branch including main). Changes are isolated
on `codex/session-pipeline-performance`. They have been tested locally and have
not been deployed. Raw measurements are in
[session-pipeline-results.json](session-pipeline-results.json).

The investigated path is Runtime -> Connector projection/coalescing -> WebSocket
or HTTP ingest -> Server sequencing/buffering -> persistence and broker fanout
-> Web event application and reconnect recovery.

## Deployment decision

The production constraint is **at most eight CPUs and at most four Server
workers**. The supplied [Compose override](../../docker/docker-compose.8cpu.yml)
therefore starts with four Uvicorn workers and one compute child per worker.
The Uvicorn supervisor is separate and does not perform request processing.

| Resource | Per Server worker | Deployment total |
| --- | ---: | ---: |
| Uvicorn workers | — | 4 |
| Compute subprocesses | 1 | 4 |
| PostgreSQL base / overflow connections | 4 / 4 | At most 32 |
| Admitted large-event jobs, including running jobs | 16 | At most 64 |
| Admitted large-event input bytes | 16 MiB | At most 64 MiB |

The container CPU ceiling is eight. This is a limit, not a reservation: Redis,
PostgreSQL, the operating system and other colocated services still share the
machine. The admission budget is not total memory; application state, outgoing
buffers, worker memory and IPC copies also consume memory. The existing general
database default of 10 base + 20 overflow connections is explicitly overridden,
so it cannot silently become 120 connections with four workers.

The Docker entry point now uses `agent_server.main`, which reads
`AGENT_SERVER_WORKERS`, `AGENT_SERVER_EVENT_WORKERS`, host and port. It rejects
multiple workers without Redis and with the single-instance Timeline shortcut.
Configured RPC instance-name prefixes receive a process-ID suffix; unset names
remain randomly generated per worker. All workers need the same auth secret,
database, Redis prefix and upload volume/S3 backend. The first-run setup token
remains process-local: bootstrap an empty database with one worker before
applying the multi-worker profile.

Four workers with two compute children each remain a **capacity experiment**,
not the production default. The 8x1 layout exceeds the worker constraint and is
included below only to describe the local scaling experiment. Process counts
alone do not establish eight-core production utilization.

## Implemented changes

### Connector

The existing 100 ms assistant-message coalescer discarded superseded snapshots
only after every input had recursively copied its body to remove runtime-owned
turn data. The production Host now marks owned snapshots for deferred
projection. Only survivors are recursively projected, immediately before the
existing WebSocket or HTTP transport. Terminal/status/source/snapshot barriers
keep their previous order. `session.turnEnded` retains its boundary data.

Content hashing still occurs when the runtime creates each platform item. This
patch does not defer hashing or assume that hashes identify the entire stored
Server row. Producers must continue publishing owned snapshots rather than
mutating nested content after publication.

Debug log argument sanitization is now lazy. When DEBUG is disabled, RPC
responses and notifications no longer traverse their full bodies just to
prepare unused log arguments. Enabled logs retain the existing sanitization.

### Server

- Capability batches parse/index one unchanged capability set for many sessions.
  Inside each session revision fence, a small `(revision, updated_at)` database
  stamp checks whether another worker replaced that set. A change refreshes the
  index, including equal-revision replacements. A newer local batch also stops
  unfinished work from the older local batch. Single-session projection filters
  unrelated session records before indexing.
- Session summaries validate only the latest item's metadata rather than
  constructing its complete body model. The SQL still fetches that item's JSON;
  this does not remove all database transfer of message bodies. Dashboard
  notification ownership uses a small join instead of loading a full session.
  The latest-item sort uses a literal matching the existing SQLite expression
  index. No PostgreSQL query-plan improvement is claimed without a live plan.
- Empty ingestion effect buckets skip the second publication fence. Failed
  publication recovery probes at most 101 IDs; a larger history requests a
  snapshot instead of decoding the whole history to make that decision.
- Subscribers in one worker share event conversion, event-ID computation,
  capability fingerprinting and JSON encoding for the same broker publication.
  Dashboard subscribers in one worker share the current snapshot build for one
  invalidation. Queued Dashboard invalidations collapse to the latest request.
  Different publications, users and Server workers have separate preparation.
- Session runtime state is stored in Redis when distributed coordination is
  enabled. Dashboard reads use one `MGET`, rather than one Redis round trip per
  session. Older sequences cannot replace newer cached state, while equal-
  sequence A -> B -> A transitions remain valid. These reconstructible cache
  entries have a 24-hour TTL; pending Timeline writes retain their separate
  non-expiring storage and persistence rules.
- Background runtime-state refreshes share a renewable Redis lease across
  workers. Duplicate refreshes skip the expensive runtime RPC rather than
  repeating it once per process. This lease does not hold the session write
  fence across a runtime RPC, so runtime callbacks can still update the session.

Outbound event transformations above 256 KiB use a warmed process pool. The
worker function only receives immutable raw JSON and returns prepared wire
events. Database connections, Redis clients and mutable session objects remain
in the Server worker. Small events stay inline to avoid IPC overhead.

Admission counts both waiting and running jobs, by count and bytes. Cancelling
a subscriber does not cancel preparation needed by other subscribers. A
cancelled running process job retains its capacity slot until it actually
finishes. Shutdown rejects queued work instead of accidentally using the default
thread executor. Capacity exhaustion closes the session WebSocket with code
1013; the existing Web reconnect/recovery path retrieves accepted content.

### Web

Capability comparison canonicalizes each record once, then sorts the canonical
strings. Previously the sort comparator repeatedly traversed parameters and
metadata. The comparison still includes extension fields, preserves duplicate
records, ignores ordering and accepts equal-sequence live state transitions.

## Local measurements

Environment: Python 3.12.13, macOS arm64, 12 logical CPUs. Each pipeline workload
was warmed once and measured three times; values below are median event-loop
thread CPU time. Baseline sources were exported from `0601e668`, and the same
script measured both checkouts. No network/database latency is included.

| Workload | Baseline | Candidate | CPU reduction |
| --- | ---: | ---: | ---: |
| Connector: 96 revisions of one approximately 64 KiB structured message | 29.570 ms | 18.168 ms | 38.6% |
| Publish capabilities: 200 sessions, 2,000 capability records | 1,064.334 ms | 16.164 ms | 98.5% |
| Single-session capability API: 200 projections over 2,000 records | 51.608 ms | 24.961 ms | 51.6% |
| Fanout: 24 large notifications, four subscribers | 155.433 ms | 48.291 ms | 68.9% |

The Connector emitted exactly one final item in both versions, with the same
content hash and 72,616 wire bytes. Capability body reads/parses fell from 200 to
one; the candidate additionally made 200 small stamp reads through the in-memory
repository port. Fanout prepared 96 deliveries in both versions. These are
component CPU comparisons, not an end-to-end request latency claim.

For four concurrent sessions, 24 notifications and four subscribers per
session, the shared inline path used 50.659 ms of event-loop CPU. Two warmed
compute children reduced that to 18.590 ms; wall time changed from 53.226 ms to
34.797 ms. The median maximum delay of a 2 ms timer changed from 6.959 ms to
0.787 ms. Pool startup was measured separately at about 259 ms.

All rows in the following scaling experiment use the **optimized code**, with
the same total 2,304 notifications and 9,216 subscriber preparations. Each
layout ran three times with warmed pools. The harness launches independent
Python worker-shaped processes and their real compute children; it does not
launch Uvicorn listeners or simulate load-balancer connection placement.

| Server-shaped workers x compute children each | Wall time | Notifications/s | Average active CPU cores |
| --- | ---: | ---: | ---: |
| 1 x 0 | 5.1500 s | 447.4 | 0.952 |
| **4 x 1: production starting profile** | **1.5409 s** | **1,495.2** | **4.230** |
| 4 x 2: capacity experiment | 1.0022 s | 2,298.9 | 7.325 |
| 8 x 1: outside the production worker constraint | 0.9567 s | 2,408.3 | 8.196 |

Active cores are measured parent-plus-compute CPU seconds divided by common
wall time, not inferred from process count. This 12-core-host result cannot
establish performance on an eight-core production host. In particular, 4x1 did
not consume eight cores in this outbound-only workload. Full ingress, database,
Redis and HTTP work changes the CPU balance and still needs production-shaped
load verification before tuning the pool upward.

A Connector's live WebSocket remains attached to one Server worker. Additional
Uvicorn workers distribute different connections, not the messages inside one
connection. A single hot Connector can still bottleneck its ingress worker;
this patch does not add an unmeasured cross-process ingestion/sharding protocol.

## Verification and reproduction

- Server: 347 passed, 14 pre-existing skips for removed persisted-notice behavior.
  Coverage includes sequencing/fences, buffered recovery, complete snapshots,
  capability concurrency, shared state, Redis cross-instance routing and tickets,
  background-refresh callback safety, process admission/cancellation, and the
  complete MVP test module.
- Connector: 146 passed, including runtime/architecture, DSH event transport,
  lazy RPC logs and the production projection/coalescing/transport path.
- Web: 265 passed; TypeScript type checking passed.
- A headless integration replay runs Connector Host/coalescer -> HTTP ingest ->
  Server WebSocket -> reconnect -> snapshot. Cases cover inline processing,
  an actual spawned compute process and capacity rejection/recovery. Final body,
  content hash and assigned sequence are retained.
- Compose configuration merges passed against both the tracked PostgreSQL file
  and the existing production definition, using placeholder credentials for
  interpolation only. No containers, development servers or external runtimes
  were started. No production database plan or production CPU profile was taken.

Run the portable benchmarks from the repository root:

```bash
uv run --project server python server/scripts/bench_session_pipeline.py --offload-workers 2
uv run --project server python server/scripts/bench_worker_scaling.py --layouts 1x0,4x1,4x2 --repeats 3
```

`bench_session_pipeline.py --repo /path/to/baseline` selects another checkout
without replacing the candidate. Do not run CPU comparisons alongside tests or
builds. Keep the Uvicorn connection-placement and database workload tests separate
from these pure CPU measurements.

## Persistence boundary

Equal-version stored-content comparison is unchanged. Existing sequence leases,
reset fences, flush/publish repair and same-sequence live transitions are retained.
The earlier prototype that conditionally read old item bodies is not included:
its repeated-version regression and lack of a production PostgreSQL plan did
not justify changing the persistence path. Adding processes does not remove
these ordering and content-consistency requirements.
