import assert from "node:assert/strict"
import test from "node:test"

import {
  compareSessionListOrder,
  sortSessionViews,
} from "../src/components/session/session-list-order.ts"

function session(id, status, sortAt) {
  return { id, status, sortAt }
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

test("running sessions always sort before non-running sessions without consulting sortAt", () => {
  const sessions = [
    session("idle_future", "idle", "2099-01-01T00:00:00Z"),
    session("running_old", "running", "2000-01-01T00:00:00Z"),
    session("running_missing", "running", null),
    session("pending_recent", "pending", "2098-01-01T00:00:00Z"),
    session("waiting_invalid", "waiting", "not-a-date"),
  ]

  assert.deepEqual(ids(sortSessionViews(sessions)), [
    "running_missing",
    "running_old",
    "idle_future",
    "pending_recent",
    "waiting_invalid",
  ])
})

test("non-running sessions retain sortAt descending and id descending order", () => {
  const sessions = [
    session("sess_a", "idle", "2026-09-03T02:00:00Z"),
    session("sess_z", "error", "2026-09-03T02:00:00Z"),
    session("sess_latest", "idle", "2026-09-03T03:00:00Z"),
    session("sess_invalid", "blocked", "not-a-date"),
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

test("a locally messaged session shares the running group during its optimistic second", () => {
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
    session("sess_old", "waiting", "2000-01-01T00:00:00Z"),
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

test("mixed running and non-running ordering is antisymmetric and transitive", () => {
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
