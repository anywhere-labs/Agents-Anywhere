import assert from "node:assert/strict"
import test from "node:test"

import {
  compareSessionListOrder,
  sessionStatusIsActive,
  sortSessionViews,
} from "../src/components/session/session-list-order.ts"

function session(id, status, sortAt, lastItemAt = null) {
  return { id, status, sortAt, lastItemAt }
}

function ids(sessions) {
  return sessions.map((item) => item.id)
}

test("running sessions ignore high-frequency sortAt updates and use ASCII id order", () => {
  const before = [
    session("sess_c", "running", "2026-09-03T03:00:00Z"),
    session("sess_a", "running", "2026-09-03T01:00:00Z"),
    session("sess_b", "running", "2026-09-03T02:00:00Z"),
  ]
  const after = [
    session("sess_c", "running", "2026-09-03T01:00:00Z"),
    session("sess_a", "running", "2026-09-03T03:00:00Z"),
    session("sess_b", "running", "2026-09-03T04:00:00Z"),
  ]

  assert.deepEqual(ids(sortSessionViews(before)), ["sess_a", "sess_b", "sess_c"])
  assert.deepEqual(ids(sortSessionViews(after)), ["sess_a", "sess_b", "sess_c"])
})

test("every working status sorts before settled sessions without consulting sortAt", () => {
  const sessions = [
    session("idle_future", "idle", "2099-01-01T00:00:00Z"),
    session("running_old", "running", "2000-01-01T00:00:00Z"),
    session("running_missing", "running", null),
    session("pending_recent", "pending", "2098-01-01T00:00:00Z"),
    session("waiting_invalid", "waiting", "not-a-date"),
    session("blocked_new", "blocked", "2097-01-01T00:00:00Z"),
    session("approval_new", "waiting_approval", "2096-01-01T00:00:00Z"),
  ]

  assert.deepEqual(ids(sortSessionViews(sessions)), [
    "approval_new",
    "blocked_new",
    "pending_recent",
    "running_missing",
    "running_old",
    "waiting_invalid",
    "idle_future",
  ])
})

test("status flaps inside the working group never reshuffle the list", () => {
  const base = [
    session("sess_b", "running", "2026-09-03T01:00:00Z"),
    session("sess_a", "running", "2026-09-03T02:00:00Z"),
    session("idle_z", "idle", "2099-01-01T00:00:00Z"),
  ]
  const order = ids(sortSessionViews(base))
  assert.deepEqual(order, ["sess_a", "sess_b", "idle_z"])

  const flapped = base.map((value) => (
    value.id === "sess_a" ? { ...value, status: "waiting_approval" } : value
  )).map((value) => (
    value.id === "sess_b" ? { ...value, status: "blocked", sortAt: "2099-06-01T00:00:00Z" } : value
  ))
  assert.deepEqual(ids(sortSessionViews(flapped)), order)
})

test("settled sessions keep the last visible item time and ignore sync-only sortAt bumps", () => {
  const before = [
    session("sess_a", "idle", "2026-09-03T02:00:00Z", "2026-09-03T02:00:00Z"),
    session("sess_b", "idle", "2026-09-03T01:00:00Z", "2026-09-03T03:00:00Z"),
  ]
  // A background sync advances sortAt only; the visible order must not move.
  const after = [
    session("sess_a", "idle", "2026-09-04T09:00:00Z", "2026-09-03T02:00:00Z"),
    session("sess_b", "idle", "2026-09-03T01:00:00Z", "2026-09-03T03:00:00Z"),
  ]

  const expected = ["sess_b", "sess_a"]
  assert.deepEqual(ids(sortSessionViews(before)), expected)
  assert.deepEqual(ids(sortSessionViews(after)), expected)
})

test("settled sessions without items fall back to sortAt then id descending", () => {
  const sessions = [
    session("sess_a", "idle", "2026-09-03T02:00:00Z"),
    session("sess_z", "error", "2026-09-03T02:00:00Z"),
    session("sess_latest", "idle", "2026-09-03T03:00:00Z"),
    session("sess_invalid", "error", "not-a-date"),
    session("sess_missing", "idle", null),
  ]

  assert.deepEqual(ids(sortSessionViews(sessions)), [
    "sess_latest",
    "sess_z",
    "sess_a",
    "sess_missing",
    "sess_invalid",
  ])
})

test("a locally messaged session shares the working group during its optimistic second", () => {
  const optimisticTopUntil = new Map([["sess_b", 2_000]])
  const sessions = [
    session("sess_c", "running", "2026-09-03T01:00:00Z"),
    session("sess_b", "idle", "2000-01-01T00:00:00Z"),
    session("sess_a", "running", "2026-09-03T03:00:00Z"),
    session("sess_latest", "idle", "2099-01-01T00:00:00Z"),
  ]

  assert.deepEqual(
    ids(sortSessionViews(sessions, { now: 1_500, optimisticTopUntil })),
    ["sess_a", "sess_b", "sess_c", "sess_latest"],
  )
  assert.equal(sessions[1].status, "idle")
})

test("optimistic ordering expires exactly at its deadline and uses the latest session state", () => {
  const optimisticTopUntil = new Map([["sess_old", 2_000]])
  const sessions = [
    session("sess_running", "running", "2026-09-03T01:00:00Z"),
    session("sess_old", "idle", "2000-01-01T00:00:00Z"),
    session("sess_latest", "idle", "2099-01-01T00:00:00Z"),
  ]

  assert.deepEqual(
    ids(sortSessionViews(sessions, { now: 1_999, optimisticTopUntil })),
    ["sess_old", "sess_running", "sess_latest"],
  )
  assert.deepEqual(
    ids(sortSessionViews(sessions, { now: 2_000, optimisticTopUntil })),
    ["sess_running", "sess_latest", "sess_old"],
  )

  const runningReply = sessions.map((value) =>
    value.id === "sess_old" ? { ...value, status: "running" } : value,
  )
  assert.deepEqual(
    ids(sortSessionViews(runningReply, { now: 2_000, optimisticTopUntil })),
    ["sess_old", "sess_running", "sess_latest"],
  )
})

test("the working-status predicate drives the in-progress view", () => {
  for (const status of ["running", "waiting", "pending", "stopping", "waiting_approval", "blocked"]) {
    assert.equal(sessionStatusIsActive(status), true, status)
  }
  for (const status of ["idle", "error", "unknown", ""]) {
    assert.equal(sessionStatusIsActive(status), false, status)
  }
})

test("mixed working and settled ordering is antisymmetric and transitive", () => {
  const values = [
    session("sess_a", "running", "2026-09-03T01:00:00Z"),
    session("sess_b", "running", "2026-09-03T03:00:00Z"),
    session("sess_c", "idle", "2026-09-03T02:00:00Z"),
    session("sess_d", "idle", "2026-09-03T00:00:00Z"),
  ]

  for (const left of values) {
    for (const right of values) {
      const forward = Math.sign(compareSessionListOrder(left, right))
      const reverse = Math.sign(compareSessionListOrder(right, left))
      assert.ok(
        (forward === 0 && reverse === 0) || forward === -reverse,
      )
    }
  }

  for (const left of values) {
    for (const middle of values) {
      for (const right of values) {
        if (
          compareSessionListOrder(left, middle) <= 0 &&
          compareSessionListOrder(middle, right) <= 0
        ) {
          assert.ok(compareSessionListOrder(left, right) <= 0)
        }
      }
    }
  }

  assert.deepEqual(ids(sortSessionViews(values)), [
    "sess_a",
    "sess_b",
    "sess_c",
    "sess_d",
  ])
})
