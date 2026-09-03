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

Two related session-open races were found during end-to-end testing:

- a live `session.state` read wrote the unchanged status through a generic
  revision publisher, which emitted the raw SQL `connectorStatus` instead of
  the current presence projection; and
- Web retained the previous session's cursor, so moving from a high-sequence
  session to a lower-sequence session requested recovery from a future cursor
  and forced a second snapshot.

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
- An unchanged session status no longer invokes the durable session publisher.
  When a real durable session change is published, every envelope containing a
  `SessionView` first overlays the current Connector presence. Timeline-only
  envelopes do not perform that presence read.
- SQL remains the durable metadata store, not the source of truth for current
  Connector presence. A ready local connection or ready Redis lease determines
  `online`; disconnect and reconnect continue to publish same-sequence session
  and capability projections.
- A snapshot derives effective capabilities again from its final presence
  projection. If the Connector disconnects during the snapshot, the response
  cannot contain an offline session with actions that are still available.
- The Web treats session meta, runtime state, capability, and catalog events as
  live projections instead of durable event-ID records. It merges capability
  sets by their semantic records, so `A -> B -> A` ends in the final `A` state.
- Web binds its event cursor and durable event-ID cache to one session
  lifecycle. Switching sessions resets that state, and a snapshot requested by
  `snapshotRequired` may authoritatively replace a future cursor after a Server
  epoch or data reset.
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
- Events already buffered when recovery starts are applied first. The recovery
  projection is applied next, and events received while the request is in
  flight are applied last. Same-sequence events retain arrival order within
  each phase.
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
| direct unchanged DB status write | no revision-publisher session meta event |
| real `runtime.capability.updated` | one capability update; its envelope also carries the current session projection |
| `session.source.updated` / `session.updated` | session meta only |

The session sequence remains the monotonic ordering cursor for durable session
and timeline changes. It is not used as a capability version.

## Regression coverage

Server tests cover the full old-capability -> turn end -> idle state -> real
capability change -> source/meta update chain and require exactly one capability
event. They also cover semantic duplicate suppression, same-sequence presence
`A -> B -> A`, disconnect/reconnect at one sequence, no-op status publication,
snapshot presence/capability consistency, and same-cursor recovery. Web tests
cover same-sequence capability `A -> B -> A`, high-to-low session switches,
authoritative future-cursor replacement, stale-session isolation, and recovery
buffer ordering while retaining exact event-ID deduplication for durable
timeline events.

Without a separate monotonic live-projection generation, the protocol cannot
strictly order a presence change that occurs inside the recovery request window
against the recovery projection across multiple Server processes. The current
phase ordering provides deterministic reconciliation without changing the
public API. A future strict-ordering extension should add a dedicated live
watermark rather than repurposing the durable Timeline sequence.

This fix intentionally does not change Connector notification production.
Further reducing redundant capability notifications before they reach the
Server is a separate optimization.
