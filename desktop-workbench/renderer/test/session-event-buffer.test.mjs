import assert from "node:assert/strict"
import test from "node:test"
import { coalesceSessionEvents, createSessionEventBuffer, SESSION_EVENT_FLUSH_MS } from "../src/components/session/session-event-buffer.ts"

function event(sequence, id = "message", sessionId = "session") {
  return { eventId: `event-${sequence}`, sessionId, sequence, cursor: `seq:${sequence}`,
    type: sequence === 1 ? "timeline.item_created" : "timeline.item_updated",
    payload: { item: { id, sessionId, updatedSeq: sequence, content: { text: String(sequence) } } } }
}

test("1000 incoming revisions per second commit at most 30 batches and flush the final text", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const commits = []
  const buffer = createSessionEventBuffer(events => commits.push({ at: Date.now(), events }))
  for (let sequence = 1; sequence <= 1000; sequence++) {
    buffer.push(event(sequence))
    t.mock.timers.tick(1)
  }
  assert.ok(commits.length > 20 && commits.length <= 30)
  t.mock.timers.tick(SESSION_EVENT_FLUSH_MS)
  assert.equal(commits.at(-1).events.at(-1).payload.item.content.text, "1000")
  for (let index = 1; index < commits.length; index++) {
    assert.ok(commits[index].at - commits[index - 1].at >= SESSION_EVENT_FLUSH_MS)
  }
  assert.ok(commits.every(commit => commit.events.length === 1))
  buffer.dispose()
})

test("snapshots and lifecycle events preserve barriers between coalesced item revisions", () => {
  const snapshot = { sequence: 3, type: "timeline.snapshot", sessionId: "session", payload: { items: [] } }
  const ended = { sequence: 6, type: "runtime.state.updated", sessionId: "session", payload: { state: { status: "idle" } } }
  const events = coalesceSessionEvents([event(1), event(2), snapshot, event(4, "next"), event(5, "next"), ended])
  assert.deepEqual(events.map(event => event.sequence), [2, 3, 5, 6])
  assert.equal(events[1], snapshot)
  assert.equal(events.at(-1), ended)
})

test("different items and sessions retain their latest contents and sequence order", () => {
  const events = coalesceSessionEvents([event(1, "a"), event(2, "b"), event(3, "a"), event(4, "a", "other")])
  assert.deepEqual(events.map(event => [event.sessionId, event.payload.item.id, event.sequence]), [
    ["session", "b", 2], ["session", "a", 3], ["other", "a", 4],
  ])
})

test("an older item revision cannot discard a newer revision already buffered", () => {
  const older = event(2)
  older.payload.item.updatedSeq = 0
  assert.deepEqual(coalesceSessionEvents([event(1), older]).map(event => event.payload.item.updatedSeq), [1, 0])
})

test("changing sessions cancels the old timer and never commits stale queued events", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const commits = []
  const buffer = createSessionEventBuffer(events => commits.push(events))
  buffer.push(event(1))
  buffer.dispose()
  buffer.push(event(2))
  t.mock.timers.tick(1000)
  assert.deepEqual(commits, [])
})
