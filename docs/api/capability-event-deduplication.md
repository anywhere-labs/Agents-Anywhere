# Capability Event Deduplication

This note documents the fix for repeated `runtime.capability.updated` events
when a session starts or changes state.

## Problem

The Server previously projected effective capabilities for every generic
session invalidation. A turn end, state update, source scan, or metadata update
could therefore each attach the same `capabilitySet`. Because an event ID also
contains the session sequence, an unchanged capability payload at a later
sequence looked like a new event to the WebSocket and Web clients.

Capability and presence are live projections. They may also change without
advancing the durable session sequence, so globally deduplicating them by
`eventId` could lose a real same-sequence transition such as `A -> B -> A`.

## Fix

The public endpoints, payload shapes, and sequence format are unchanged.

- The Server's Connector-ingest path projects capabilities only for a real
  `protocol.capabilitiesUpdated` or `runtime.capability.updated` change. Generic
  session, turn, state, source, and scanner updates no longer read or attach a
  capability set.
- A session WebSocket suppresses only adjacent, semantically identical
  capability projections. Capability-set revision and list order alone do not
  create a client update; full capability records are still compared.
- Other current-state projections use adjacent per-type deduplication. This
  preserves a real same-sequence `online -> offline -> online` transition.
- The Web treats session meta, runtime state, capability, and catalog events as
  live projections instead of durable event-ID records. It merges capability
  sets by their semantic records, so `A -> B -> A` ends in the final `A` state.
- Cursor recovery at the current session sequence returns current session meta
  and the latest persisted effective capability projection. A persisted
  capability change, or a current presence change, is therefore recoverable
  even when the durable sequence did not advance. Its
  `nextCursor` intentionally remains unchanged; clients treat this as a one-shot
  projection response and do not request the same cursor repeatedly.
- Web starts initial cursor reconciliation and reconnect recovery only after
  receiving `session.subscribed`. The Server has registered the broker
  subscription at that point, closing the gap in which a same-sequence
  capability could otherwise change after recovery but before the new socket
  started receiving events.
- When the connector is online, Web follows recovery with the existing live
  session capability read and treats that Runtime result as authoritative. A
  persisted recovery projection cannot overwrite a newer manual snapshot/live
  read. When the connector is offline, Web uses the persisted projection so the
  current platform availability is still restored.

The expected session-start flow is now:

| Input | Session WebSocket output |
| --- | --- |
| `session.turnEnded` | session meta only |
| `session.state.updated` | runtime state and session meta |
| real `runtime.capability.updated` | one capability update; its envelope also carries the current session projection |
| `session.source.updated` / `session.updated` | session meta only |

The session sequence remains the monotonic ordering cursor for durable session
and timeline changes. It is not used as a capability version.

## Regression coverage

Server tests cover the full old-capability -> turn end -> idle state -> real
capability change -> source/meta update chain and require exactly one capability
event. They also cover semantic duplicate suppression, same-sequence presence
`A -> B -> A`, and same-cursor recovery. Web tests cover same-sequence
capability `A -> B -> A` while retaining exact event-ID deduplication for
durable timeline events.

This fix intentionally does not change Connector notification production.
Further reducing redundant capability notifications before they reach the
Server is a separate optimization.
