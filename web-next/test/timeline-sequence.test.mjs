import assert from "node:assert/strict"
import test from "node:test"

import {
  incomingTimelineItemCanReplace,
  mergeSequencedTimelineSnapshot,
} from "../src/components/session/timeline-sequence.ts"

function item(id, updatedSeq, value, optimistic = false) {
  return { id, updatedSeq, value, optimistic }
}

test("lower item sequence cannot replace the live item", () => {
  const live = item("message", 12, "live")
  const stale = item("message", 11, "stale")

  assert.equal(incomingTimelineItemCanReplace(live, stale), false)
  const merged = mergeSequencedTimelineSnapshot([live], 12, [stale], 11)
  assert.deepEqual(merged, { items: [live], nextSeq: 12 })
})

test("equal item sequence keeps the later arrival", () => {
  const current = item("message", 12, "current")
  const later = item("message", 12, "later")

  assert.equal(incomingTimelineItemCanReplace(current, later), true)
  const merged = mergeSequencedTimelineSnapshot([current], 12, [later], 12)
  assert.deepEqual(merged, { items: [later], nextSeq: 12 })
})

test("higher item sequence replaces the current item", () => {
  const current = item("message", 12, "current")
  const newer = item("message", 13, "newer")

  const merged = mergeSequencedTimelineSnapshot([current], 12, [newer], 13)
  assert.deepEqual(merged, { items: [newer], nextSeq: 13 })
})

test("stale snapshot preserves newer live and optimistic items without regressing nextSeq", () => {
  const live = item("live", 12, "live")
  const covered = item("covered", 4, "covered")
  const optimistic = item("optimistic", 3, "optimistic", true)
  const staleLive = item("live", 9, "stale")
  const durable = item("durable", 9, "durable")

  const merged = mergeSequencedTimelineSnapshot(
    [live, covered, optimistic],
    12,
    [staleLive, durable],
    9,
    (entry) => entry.optimistic,
  )

  assert.deepEqual(merged, {
    items: [live, optimistic, durable],
    nextSeq: 12,
  })
})
