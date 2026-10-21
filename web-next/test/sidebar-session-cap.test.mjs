import assert from "node:assert/strict"
import test from "node:test"
import {
  SIDEBAR_RECENT_SESSION_LIMIT,
  capRecentSessions,
} from "../src/components/sidebar/sidebar-session-cap.ts"

const sessions = (count) =>
  Array.from({ length: count }, (_, index) => ({ id: `s${index}` }))

test("a list under the limit is passed through untouched", () => {
  const list = sessions(SIDEBAR_RECENT_SESSION_LIMIT)
  const { visible, hiddenCount } = capRecentSessions(list, { expanded: false })
  assert.equal(visible.length, SIDEBAR_RECENT_SESSION_LIMIT)
  assert.equal(hiddenCount, 0)
})

test("the overflow is counted, not dropped silently", () => {
  const { visible, hiddenCount } = capRecentSessions(sessions(63), {
    expanded: false,
  })
  assert.equal(visible.length, SIDEBAR_RECENT_SESSION_LIMIT)
  assert.equal(hiddenCount, 13)
  assert.equal(visible.length + hiddenCount, 63)
})

test("expanding reveals everything and clears the counter", () => {
  const { visible, hiddenCount } = capRecentSessions(sessions(200), {
    expanded: true,
  })
  assert.equal(visible.length, 200)
  assert.equal(hiddenCount, 0)
})

test("the open session stays visible even when it sorts past the cut", () => {
  const list = sessions(120)
  const { visible, hiddenCount } = capRecentSessions(list, {
    expanded: false,
    activeSessionId: "s119",
  })
  assert.ok(visible.some((item) => item.id === "s119"))
  // The rescued session must not also be counted as hidden.
  assert.equal(hiddenCount, 69)
  assert.equal(visible.length + hiddenCount, 120)
})

test("an active session inside the cap is not duplicated", () => {
  const { visible, hiddenCount } = capRecentSessions(sessions(120), {
    expanded: false,
    activeSessionId: "s0",
  })
  assert.equal(visible.filter((item) => item.id === "s0").length, 1)
  assert.equal(visible.length, SIDEBAR_RECENT_SESSION_LIMIT)
  assert.equal(hiddenCount, 70)
})

test("the head of the list survives, so running sessions are never cut", () => {
  // The caller sorts with compareSessionListOrder, which floats running
  // sessions to the front; the cap only ever removes from the tail.
  const list = sessions(300)
  const { visible } = capRecentSessions(list, { expanded: false })
  assert.equal(visible[0].id, "s0")
  assert.equal(visible[SIDEBAR_RECENT_SESSION_LIMIT - 1].id, "s49")
})

test("capping does not mutate the caller's array", () => {
  const list = sessions(120)
  capRecentSessions(list, { expanded: false, activeSessionId: "s119" })
  assert.equal(list.length, 120)
})
