import assert from "node:assert/strict"
import test from "node:test"

import { latestPlanRevisions, placePlanDocuments, planEchoFilter, planReviewStatus } from "../src/features/planning/timeline.ts"

const item = (id, role, createdAt, text = "") => ({ id, role, createdAt, type: "message", content: { text }, source: {} })
const doc = (planId, revision, createdAt, markdown = `plan ${planId}:${revision}`) => ({ planId, revision, createdAt, markdown, contentHash: "h", title: "t" })
const group = (key, ...items) => ({ key, items })

test("plan timeline: an approved plan sits directly above the implementation it started", () => {
  const groups = [
    group("ask", item("u1", "user", "2026-10-30T10:00:00Z")),
    group("plan-turn", item("s1", "system", "2026-10-30T10:01:00Z")),
    group("implement", item("u2", "user", "2026-10-30T10:05:00Z"), item("a2", "assistant", "2026-10-30T10:05:10Z")),
  ]
  const placement = placePlanDocuments([doc("p", 1, "2026-10-30T10:01:30Z")], groups)
  assert.deepEqual([...placement.before.keys()], ["implement"])
  assert.equal(placement.end.length, 0)
})

test("plan timeline: a plan still under review and one without a time stay at the end", () => {
  const groups = [group("ask", item("u1", "user", "2026-10-30T10:00:00Z"))]
  const placement = placePlanDocuments([doc("p", 1, "2026-10-30T10:01:00Z"), doc("q", 1, undefined)], groups)
  assert.equal(placement.before.size, 0)
  assert.deepEqual(placement.end.map(d => d.planId), ["p", "q"])
})

test("plan timeline: revisions keep chronological order before the next user message", () => {
  const groups = [
    group("feedback", item("u1", "user", "2026-10-30T10:02:00Z")),
    group("implement", item("u2", "user", "2026-10-30T10:06:00Z")),
  ]
  const placement = placePlanDocuments([doc("p", 2, "2026-10-30T10:04:00Z"), doc("p", 1, "2026-10-30T10:01:00Z")], groups)
  assert.deepEqual(placement.before.get("feedback").map(d => d.revision), [1])
  assert.deepEqual(placement.before.get("implement").map(d => d.revision), [2])
  assert.equal(latestPlanRevisions([doc("p", 1), doc("p", 2), doc("q", 1)]).get("p"), 2)
})

test("plan timeline: a system message echoing a plan or its draft is hidden, others stay", () => {
  const keep = planEchoFilter({ draft: { content: "draft so far and more" } }, [doc("p", 1, undefined, "# Plan\n\nbody")])
  assert.equal(keep(item("s", "system", ""), "  # Plan\n\nbody \n"), false)
  assert.equal(keep(item("s", "system", ""), "draft so far"), false)
  assert.equal(keep(item("s", "system", ""), "unrelated notice"), true)
  assert.equal(keep(item("a", "assistant", ""), "# Plan\n\nbody"), true)
})

test("plan timeline: status belongs only to the reviewed version", () => {
  const state = { review: { planId: "p", planRevision: 2, status: "approved" }, execution: { status: "started" } }
  assert.equal(planReviewStatus(state, doc("p", 2)), "statusExecuted")
  assert.equal(planReviewStatus(state, doc("p", 1)), null)
  assert.equal(planReviewStatus({ review: { planId: "p", planRevision: 1, status: "revision_requested" } }, doc("p", 1)), "statusRevisionRequested")
})
