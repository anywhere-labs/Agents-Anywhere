# Session pipeline performance

Baseline: 0601e668 (production branch, including main). Work is isolated from the
primary checkout. This change is validated locally; deployment is a separate step.

The path under investigation is Runtime -> Connector projection/coalescing ->
WebSocket or HTTP ingest -> Server revision allocation/buffering -> persistence
and broker fanout -> Web event application.

Initial confirmed costs:

- Connector computes the canonical content hash and recursively removes turn
  data before the 100 ms assistant-message coalescer can discard superseded
  snapshots. Debug arguments are sanitized even when DEBUG output is disabled.
- Server capability publication reads and validates the connector's entire
  capability set for every session. Session summaries validate the complete
  newest message, including its body.
- Each Server WebSocket subscriber independently prepares and JSON-encodes the
  same events. Each Dashboard subscriber independently builds the same snapshot.
- Web capability comparison serializes records repeatedly inside a sort
  comparator.

Contracts to retain:

- Runtime contentHash identifies type, status, role and content. It is not the
  Server's updatedSeq, and it does not identify the complete normalized row.
- Complete intermediate item upserts can be coalesced. Snapshots, source/state
  transitions, notices and turn completion are ordering barriers.
- Server allocates a new sequence before publishing a changed timeline item.
  Sequence leases, snapshot reset fences and failed-publication repair remain
  authoritative.
- Same-sequence live session/capability A -> B -> A transitions remain visible.
- Cancelled subscribers cannot cancel shared preparation needed by others.
- Queues/executors require bounded admission; pending unpersisted writes cannot
  be discarded as cache entries.

Measurements, final implementation scope and regression results will be added
after the corresponding local checks.
