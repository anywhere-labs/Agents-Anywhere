import assert from "node:assert/strict"
import test from "node:test"

import { isVisibleTimelineItem } from "../src/components/session/session-utils.ts"

function timelineItem(overrides = {}) {
  return {
    id: "item-1",
    sessionId: "session-1",
    type: "message",
    status: "done",
    role: "user",
    content: { text: "hello" },
    source: { runtime: "claude" },
    orderSeq: 1,
    revision: 1,
    contentHash: "hash",
    updatedSeq: 1,
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
    completedAt: null,
    ...overrides,
  }
}

test("hides Claude's synthetic interrupted-request user message", () => {
  for (const text of [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
  ]) {
    assert.equal(isVisibleTimelineItem(timelineItem({ content: { text } })), false)
  }
})

test("hides Claude's synthetic no-response assistant message", () => {
  assert.equal(
    isVisibleTimelineItem(
      timelineItem({ role: "assistant", content: { text: "No response requested." } }),
    ),
    false,
  )
})

test("does not hide the same text outside Claude user messages", () => {
  const content = { text: "[Request interrupted by user]" }

  assert.equal(isVisibleTimelineItem(timelineItem({ source: { runtime: "codex" }, content })), true)
  assert.equal(isVisibleTimelineItem(timelineItem({ role: "assistant", content })), true)
  assert.equal(isVisibleTimelineItem(timelineItem({ type: "system", role: "system", content })), true)
  assert.equal(
    isVisibleTimelineItem(
      timelineItem({
        source: { runtime: "codex" },
        role: "assistant",
        content: { text: "No response requested." },
      }),
    ),
    true,
  )
})

test("keeps ordinary Claude user messages visible", () => {
  assert.equal(isVisibleTimelineItem(timelineItem()), true)
})
