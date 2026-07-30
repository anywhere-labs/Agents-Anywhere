# Event and Recovery Contract

The v2 event cursor is a durable session-state revision token. It is formatted
as `seq:<revision>` and is not a Redis Pub/Sub offset or a persisted event-log
position.

PostgreSQL remains the durable source of truth. Redis carries ephemeral
invalidation messages between Server instances, and WebSocket projects those
messages into protocol events. A lost Redis message is recovered from database
state, not replayed from Redis.

## Recovery outcomes

`GET /api/v2/sessions/{sessionId}/events?after=seq:<revision>` returns exactly
one of these outcomes:

- A deterministic state delta with `snapshotRequired: false`.
- No events with `snapshotRequired: true`, requiring the client to fetch the
  session snapshot again.

Recovery requires a stable database revision while the session, timeline,
notices, and effective capabilities are read. It falls back to a snapshot when:

- the supplied cursor is ahead of the durable session revision;
- the supplied cursor equals the durable revision, because ephemeral Connector
  presence and its derived capabilities are not encoded in the database cursor;
- the database revision keeps changing during recovery;
- the timeline delta exceeds the recovery limit;
- one or more durable revisions can no longer be represented from current
  state because an entity was updated repeatedly or removed.

Timeline replacements that remove items leave a durable recovery barrier in the
session revision sequence. This avoids a new event-log table while ensuring a
client cannot mistake a partial state projection for a complete replay.

## WebSocket invalidations

Database writes complete before a timeline invalidation is published. Normal
item changes produce `timeline.item_created` or `timeline.item_updated` events.
An authoritative `timeline.sync` produces `timeline.snapshot`, whose `items`
replace the client's server-backed timeline while preserving unconfirmed local
optimistic messages. Changes that can close or remove Interactions produce
`notice.snapshot`, so stale open notices are removed instead of being inferred
from the absence of an item event.

Clients must use `snapshotRequired` and revision gaps as correctness signals.
Successful Pub/Sub delivery alone never proves that recovery is complete.
