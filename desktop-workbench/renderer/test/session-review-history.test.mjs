import assert from "node:assert/strict"
import test from "node:test"

import {
  combineReviewTimeline,
  emptyReviewHistory,
  nextTimelineResetVersion,
  updateReviewHistoryForResetVersion,
} from "../src/components/session/session-review-history.ts"

function mergeUnique(historyItems, timelineItems) {
  return Array.from(new Set([...historyItems, ...timelineItems]))
}

test("only authoritative timeline replacement advances the reset version", () => {
  assert.equal(nextTimelineResetVersion(7, false), 7)
  assert.equal(nextTimelineResetVersion(7, true), 8)
})

test("an authoritative reset excludes cached file changes and stale pagination state", () => {
  const history = {
    items: ["removed-file-change"],
    hasMore: true,
    error: "old page failed",
    resetVersion: 2,
  }

  const combined = combineReviewTimeline(
    history,
    {
      items: ["authoritative-message"],
      hasMore: false,
      resetVersion: 3,
    },
    mergeUnique,
  )

  assert.deepEqual(combined, {
    items: ["authoritative-message"],
    hasMore: false,
    error: null,
  })
})

test("a history page from an older reset version cannot write back", () => {
  const current = emptyReviewHistory(4)
  const result = updateReviewHistoryForResetVersion(current, 3, () => {
    throw new Error("stale update should not run")
  })

  assert.equal(result, current)
})

test("ordinary realtime items merge without discarding current history", () => {
  const combined = combineReviewTimeline(
    {
      items: ["older-turn"],
      hasMore: false,
      error: null,
      resetVersion: 5,
    },
    {
      items: ["live-file-change"],
      hasMore: true,
      resetVersion: 5,
    },
    mergeUnique,
  )

  assert.deepEqual(combined, {
    items: ["older-turn", "live-file-change"],
    hasMore: false,
    error: null,
  })
})
