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
