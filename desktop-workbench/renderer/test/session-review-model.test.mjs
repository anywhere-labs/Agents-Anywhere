import assert from "node:assert/strict"
import test from "node:test"

import {
  buildLatestChangedTurnReview,
  canonicalReviewPath,
  diffLineCounts,
  fileChangeAction,
} from "../src/components/session/session-review-model.ts"

function item({
  id,
  orderSeq,
  type = "artifact",
  role = null,
  content = {},
  source = { runtime: "codex" },
  updatedSeq = orderSeq,
  revision = 1,
}) {
  return {
    id,
    sessionId: "session-1",
    type,
    status: "done",
    role,
    content,
    source,
    orderSeq,
    revision,
    contentHash: `${id}:${revision}`,
    updatedSeq,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    completedAt: null,
  }
}

function user(id, orderSeq, options = {}) {
  return item({ id, orderSeq, type: "message", role: "user", content: { text: id }, ...options })
}

function fileChange(id, orderSeq, changes, options = {}) {
  return item({
    id,
    orderSeq,
    content: { kind: "file_change", changes },
    ...options,
  })
}

test("keeps the previous changed turn until the current turn emits a file change", () => {
  const firstTurn = [
    user("turn-a", 1),
    fileChange("change-a", 2, [{ path: "src/a.ts", action: "modify", diff: "@@\n-old\n+new" }]),
  ]
  const withoutCurrentChange = buildLatestChangedTurnReview([
    ...firstTurn,
    user("turn-b", 3),
    item({ id: "command-b", orderSeq: 4, type: "tool", content: { kind: "command" } }),
  ], { root: "/repo" })

  assert.equal(withoutCurrentChange?.key, "turn-a")
  assert.deepEqual(withoutCurrentChange?.files.map((file) => file.displayPath), ["src/a.ts"])

  const withCurrentChange = buildLatestChangedTurnReview([
    ...firstTurn,
    user("turn-b", 3),
    fileChange("change-b", 5, [{ path: "src/b.ts", action: "add", diff: "one\ntwo\n" }]),
  ], { root: "/repo" })

  assert.equal(withCurrentChange?.key, "turn-b")
  assert.deepEqual(withCurrentChange?.files.map((file) => file.displayPath), ["src/b.ts"])
  assert.deepEqual(
    { additions: withCurrentChange?.files[0]?.additions, deletions: withCurrentChange?.files[0]?.deletions },
    { additions: 2, deletions: 0 },
  )
})

test("uses visible non-steering user messages as turn boundaries", () => {
  const review = buildLatestChangedTurnReview([
    user("turn-a", 1, { source: { runtime: "codex", clientMessageId: "client-turn-a" } }),
    fileChange("change-a", 2, [{ path: "src/a.ts", action: "modify", diff: "-a\n+b" }]),
    user("steering", 3, { source: { runtime: "codex", itemType: "steeringUserMessage" } }),
    fileChange("change-b", 4, [{ path: "src/b.ts", action: "modify", diff: "-b\n+c" }]),
    user("interrupted", 5, {
      content: { text: "[Request interrupted by user for tool use]" },
      source: { runtime: "claude", itemType: "userMessage" },
    }),
    fileChange("change-c", 6, [{ path: "src/c.ts", action: "modify", diff: "-c\n+d" }]),
  ], { root: "/repo" })

  assert.equal(review?.key, "client-turn-a")
  assert.deepEqual(review?.files.map((file) => file.displayPath), ["src/a.ts", "src/b.ts", "src/c.ts"])
})

test("a Claude interruption marker does not hide a previous changed turn", () => {
  const review = buildLatestChangedTurnReview([
    user("turn-a", 1),
    fileChange("change-a", 2, [{ path: "src/a.ts", action: "modify", diff: "-a\n+b" }]),
    user("interrupted", 3, {
      content: { text: "[Request interrupted by user]" },
      source: { runtime: "claude", itemType: "userMessage" },
    }),
    item({ id: "answer", orderSeq: 4, type: "message", role: "assistant", content: { text: "stopped" } }),
  ], { root: "/repo" })

  assert.equal(review?.key, "turn-a")
  assert.deepEqual(review?.files.map((file) => file.displayPath), ["src/a.ts"])
})

test("uses only the latest revision of a streaming file change item", () => {
  const review = buildLatestChangedTurnReview([
    user("turn-a", 1),
    fileChange("change", 2, [{ path: "old.ts", action: "modify", diff: "-old\n+older" }], {
      revision: 1,
      updatedSeq: 2,
    }),
    fileChange("change", 2, [{ path: "new.ts", action: "update", diff: "-old\n+new" }], {
      revision: 2,
      updatedSeq: 3,
    }),
  ], { root: "/repo" })

  assert.equal(review?.key, "turn-a")
  assert.deepEqual(review?.files.map((file) => file.displayPath), ["new.ts"])
  assert.deepEqual(
    { additions: review?.files[0]?.additions, deletions: review?.files[0]?.deletions },
    { additions: 1, deletions: 1 },
  )
})

test("supports direct artifact patches and ignores pathless patch deltas", () => {
  const pathless = buildLatestChangedTurnReview([
    user("turn-a", 1),
    item({
      id: "delta",
      orderSeq: 2,
      content: { kind: "file_change", patch: "+partial" },
    }),
  ], { root: "/repo" })
  assert.equal(pathless, null)

  const direct = buildLatestChangedTurnReview([
    user("turn-a", 1),
    item({
      id: "artifact",
      orderSeq: 2,
      content: { kind: "file_change", path: "app.py", action: "modify", patch: "@@\n-old\n+new" },
    }),
  ], { root: "/repo" })
  assert.equal(direct?.files[0]?.path, "/repo/app.py")
})

test("folds repeated file operations into the turn-level result", () => {
  const review = buildLatestChangedTurnReview([
    user("turn-a", 1),
    fileChange("first", 2, [
      { path: "src/new.ts", action: "add", diff: "first\n" },
      { path: "src/gone.ts", action: "modify", diff: "-before\n+after" },
      { path: "src/temp.ts", action: "add", diff: "temporary" },
    ]),
    fileChange("second", 3, [
      { path: "/repo/src/new.ts", action: "update", diff: "-first\n+second" },
      { path: "src/gone.ts", action: "delete", diff: "-after" },
      { path: "src/temp.ts", action: "delete", diff: "-temporary" },
    ]),
  ], { root: "/repo" })

  assert.deepEqual(
    review?.files.map((file) => [file.displayPath, file.action]),
    [["src/new.ts", "add"], ["src/gone.ts", "delete"]],
  )
})

test("keeps repeated file diffs as chronological cards under one file", () => {
  const review = buildLatestChangedTurnReview([
    user("turn-a", 1),
    fileChange("first", 2, [{ path: "src/a.ts", action: "modify", diff: "-old\n+new" }]),
    fileChange("second", 3, [{ path: "src/a.ts", action: "modify", diff: "-new\n+newer" }]),
  ], { root: "/repo" })

  assert.equal(review?.files.length, 1)
  assert.deepEqual(
    review?.files[0]?.diffs.map((entry) => [entry.id, entry.diff, entry.orderSeq]),
    [
      ["first:0", "-old\n+new", 2],
      ["second:0", "-new\n+newer", 3],
    ],
  )
  assert.deepEqual(
    { additions: review?.files[0]?.additions, deletions: review?.files[0]?.deletions },
    { additions: 2, deletions: 2 },
  )
  assert.deepEqual(review?.files[0]?.sourceItemIds, ["first", "second"])
})

test("deduplicates Windows paths case-insensitively and accepts map-shaped changes", () => {
  const review = buildLatestChangedTurnReview([
    user("turn-a", 1),
    fileChange("first", 2, {
      "Src\\Main.ts": { action: "modified", diff: "-a\n+b" },
    }),
    fileChange("second", 3, [{
      path: "c:\\repo\\src\\main.ts",
      action: "updated",
      diff: "-b\n+c",
    }]),
  ], { root: "C:\\repo", caseInsensitivePaths: true })

  assert.equal(review?.files.length, 1)
  assert.equal(review?.files[0]?.path, "C:/repo/Src/Main.ts")
  assert.equal(review?.files[0]?.displayPath, "Src/Main.ts")
  assert.deepEqual(
    { additions: review?.files[0]?.additions, deletions: review?.files[0]?.deletions },
    { additions: 2, deletions: 2 },
  )
})

test("recognizes update as modification and counts diff lines without headers", () => {
  assert.equal(fileChangeAction({ action: "update" }), "modify")
  assert.deepEqual(diffLineCounts("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n---flag\n++++counter\n"), {
    additions: 2,
    deletions: 2,
  })
  assert.equal(canonicalReviewPath("src\\main.ts", "C:\\repo", true), "c:/repo/src/main.ts")
})

test("treats a loaded timeline window that starts mid-turn as a reviewable prelude", () => {
  const review = buildLatestChangedTurnReview([
    fileChange("change", 50, [{ path: "src/a.ts", action: "modify", diff: "+line" }]),
    item({ id: "answer", orderSeq: 51, type: "message", role: "assistant", content: { text: "done" } }),
  ], { root: "/repo" })

  assert.equal(review?.key, "prelude")
  assert.equal(review?.files[0]?.displayPath, "src/a.ts")
})
