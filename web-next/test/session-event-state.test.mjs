import assert from "node:assert/strict"
import test from "node:test"

import {
  acceptSessionEventId,
  bufferedEventsAfterLiveCapabilityRead,
  drainSessionEventBuffer,
  mergeEffectiveCapabilities,
  SessionEventSequenceCursor,
  settleSessionEventRecovery,
} from "../src/components/session/session-event-state.ts"

function capabilitySet(allowed) {
  return {
    revision: 10,
    capabilities: [
      {
        capabilityId: "session.send_message",
        scope: "session",
        runtime: "codex",
        runtimeId: "codex",
        sessionId: "session-1",
        supported: true,
        available: true,
        allowed,
        unavailableReason: allowed ? null : "session_not_taken_over",
        parameters: {},
      },
    ],
  }
}

function capabilityEvent(capabilitySetValue) {
  return {
    protocolVersion: "1.0",
    eventId: capabilitySetValue.capabilities[0].allowed ? "evt_10_a" : "evt_10_b",
    sequence: 10,
    cursor: "seq:10",
    type: "runtime.capability.updated",
    sessionId: "session-1",
    emittedAt: "2026-09-02T00:00:00Z",
    payload: { capabilitySet: capabilitySetValue },
  }
}

function presenceEvent(status, eventId) {
  return {
    protocolVersion: "1.0",
    eventId,
    sequence: 10,
    cursor: "seq:10",
    type: "session.meta.updated",
    sessionId: "session-1",
    emittedAt: "2026-09-02T00:00:00Z",
    payload: {
      session: {
        id: "session-1",
        connectorStatus: status,
      },
    },
  }
}

function applyPresenceEvent(cursor, event, currentStatus) {
  if (!cursor.accepts(event.sessionId, event.sequence)) return currentStatus
  cursor.advance(event.sessionId, event.sequence)
  return event.payload.session.connectorStatus
}

test("same-sequence capability A-B-A is not rejected by durable event-id dedup", () => {
  const first = capabilityEvent(capabilitySet(true))
  const middle = capabilityEvent(capabilitySet(false))
  const last = capabilityEvent(capabilitySet(true))
  const processedEventIds = new Set()

  assert.equal(first.eventId, last.eventId)
  assert.equal(acceptSessionEventId(first, processedEventIds), true)
  assert.equal(acceptSessionEventId(middle, processedEventIds), true)
  assert.equal(acceptSessionEventId(last, processedEventIds), true)

  let current = null
  current = mergeEffectiveCapabilities(current, first.payload.capabilitySet)
  current = mergeEffectiveCapabilities(current, middle.payload.capabilitySet)
  current = mergeEffectiveCapabilities(current, last.payload.capabilitySet)
  assert.equal(current.capabilities[0].allowed, true)
})

test("durable events keep exact event-id dedup", () => {
  const event = {
    ...capabilityEvent(capabilitySet(true)),
    eventId: "evt_10_timeline",
    type: "timeline.item_updated",
    payload: { item: { id: "item-1" } },
  }
  const processedEventIds = new Set()

  assert.equal(acceptSessionEventId(event, processedEventIds), true)
  assert.equal(acceptSessionEventId(event, processedEventIds), false)
})

test("session switch resets a higher sequence before recovering a lower-sequence session", () => {
  const cursor = new SessionEventSequenceCursor("session-high", 32807)

  cursor.switchTo("session-low")
  assert.equal(cursor.current("session-low"), 0)

  cursor.advance("session-low", 1072)
  assert.equal(cursor.current("session-low"), 1072)
  assert.equal(cursor.accepts("session-low", 1072), true)
  assert.equal(cursor.accepts("session-low", 1071), false)
})

test("stale session work cannot alter the current session cursor", () => {
  const cursor = new SessionEventSequenceCursor("session-high", 32807)
  cursor.switchTo("session-low", 1072)

  cursor.advance("session-high", 40000)

  assert.equal(cursor.current("session-low"), 1072)
  assert.equal(cursor.current("session-high"), 0)
  assert.equal(cursor.accepts("session-high", 40000), false)
})

test("authoritative snapshot can replace a future cursor in the same session", () => {
  const cursor = new SessionEventSequenceCursor("session-reset", 32807)

  cursor.replaceFromSnapshot("session-reset", 1072)

  assert.equal(cursor.current("session-reset"), 1072)
  assert.equal(cursor.accepts("session-reset", 1072), true)
})

test("stale session snapshot cannot replace the current session cursor", () => {
  const cursor = new SessionEventSequenceCursor("session-old", 32807)
  cursor.switchTo("session-current", 1072)

  cursor.replaceFromSnapshot("session-old", 10)

  assert.equal(cursor.current("session-current"), 1072)
})

test("pre-recovery same-sequence presence is applied before recovered presence", () => {
  const cursor = new SessionEventSequenceCursor("session-1", 10)
  let status = "offline"
  const apply = (event) => {
    status = applyPresenceEvent(cursor, event, status)
  }

  const remaining = drainSessionEventBuffer(
    [presenceEvent("online", "evt_pre_online")],
    apply,
  )
  apply(presenceEvent("offline", "evt_recovery_offline"))

  assert.deepEqual(remaining, [])
  assert.equal(status, "offline")
})

test("same-sequence presence received during recovery is applied after recovery", () => {
  const cursor = new SessionEventSequenceCursor("session-1", 10)
  let status = "offline"
  const apply = (event) => {
    status = applyPresenceEvent(cursor, event, status)
  }

  apply(presenceEvent("offline", "evt_recovery_offline"))
  const remaining = drainSessionEventBuffer(
    [presenceEvent("online", "evt_during_online")],
    apply,
  )

  assert.deepEqual(remaining, [])
  assert.equal(status, "online")
})

test("buffer drain preserves later events when an event starts nested recovery", () => {
  const refetch = {
    ...presenceEvent("offline", "evt_refetch"),
    type: "session.refetch_required",
    payload: {},
  }
  const online = presenceEvent("online", "evt_after_refetch")
  const applied = []
  let recoveryStarted = false

  const remaining = drainSessionEventBuffer(
    [refetch, online],
    (event) => {
      applied.push(event)
      if (event.type === "session.refetch_required") recoveryStarted = true
    },
    () => recoveryStarted,
  )

  assert.deepEqual(applied, [refetch])
  assert.deepEqual(remaining, [online])
})

test("recovery releases its gate before draining events received in flight", async () => {
  let resolveRecovery
  const recovery = new Promise((resolve) => {
    resolveRecovery = resolve
  })
  const buffered = [presenceEvent("online", "evt_during_recovery")]
  const applied = []
  let recoveryActive = true

  const settled = settleSessionEventRecovery(
    recovery,
    () => {
      recoveryActive = false
    },
    () => {
      const remaining = drainSessionEventBuffer(
        buffered,
        (event) => applied.push(event),
        () => recoveryActive,
      )
      assert.deepEqual(remaining, [])
    },
  )

  await Promise.resolve()
  assert.deepEqual(applied, [])

  resolveRecovery()
  await settled

  assert.equal(recoveryActive, false)
  assert.deepEqual(applied, buffered)
})

test("capability comparison ignores set revision and capability order", () => {
  const first = capabilitySet(true)
  first.capabilities.push({
    ...first.capabilities[0],
    capabilityId: "session.interrupt",
  })
  const reordered = {
    revision: 99,
    capabilities: [...first.capabilities].reverse(),
  }

  assert.equal(mergeEffectiveCapabilities(first, reordered), first)
})

test("capability comparison includes complete records such as runtimeId", () => {
  const first = capabilitySet(true)
  const changed = capabilitySet(true)
  changed.capabilities[0].runtimeId = "codex-work"

  assert.equal(mergeEffectiveCapabilities(first, changed), changed)
})

test("live capability cutover discards only pre-read capability projections", () => {
  const capabilityBeforeRead = capabilityEvent(capabilitySet(false))
  const capabilityDuringRead = {
    ...capabilityEvent(capabilitySet(true)),
    eventId: "evt_10_capability_during_read",
  }
  const session = {
    ...capabilityBeforeRead,
    eventId: "evt_10_session",
    type: "session.meta.updated",
    payload: { session: { id: "session-1" } },
  }
  const timeline = {
    ...capabilityBeforeRead,
    eventId: "evt_10_timeline",
    type: "timeline.item_updated",
    payload: { item: { id: "item-1" } },
  }

  assert.deepEqual(
    bufferedEventsAfterLiveCapabilityRead(
      [session, capabilityBeforeRead],
      [capabilityDuringRead, timeline],
      true,
    ),
    [session, capabilityDuringRead, timeline],
  )
  assert.deepEqual(
    bufferedEventsAfterLiveCapabilityRead(
      [session, capabilityBeforeRead],
      [capabilityDuringRead, timeline],
      false,
    ),
    [session, capabilityBeforeRead, capabilityDuringRead, timeline],
  )
})
