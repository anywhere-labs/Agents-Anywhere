import assert from "node:assert/strict"
import test from "node:test"

import {
  acceptSessionEventId,
  bufferedEventsAfterLiveCapabilityRead,
  mergeEffectiveCapabilities,
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
