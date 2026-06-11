// Pure-logic tests for the attachment reconcile module. No test runner needed:
//
//   node web/test/attachmentReconcile.test.mjs
//
// Requires Node >= 22.18 / 23.6 (TypeScript type-stripping for the imported .ts).
import assert from "node:assert/strict";
import {
  userMessageMatches,
  stripInjectedAttachmentMentions,
  assignSentRecords,
  extractAttachments,
  mergeOptimisticTimelineItems,
} from "../src/lib/attachmentReconcile.ts";

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log("  ok -", name);
};

const T0 = Date.parse("2026-05-28T16:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const userItem = (id, text, ms, clientMessageId) => ({
  id,
  type: "message",
  role: "user",
  content: { text },
  source: clientMessageId ? { clientMessageId } : {},
  createdAt: at(ms),
});
const timelineItem = (id, type, role, turnId, orderSeq, updatedSeq, extra = {}) => ({
  id,
  sessionId: "sess",
  turnId,
  type,
  status: type === "turn.start" ? "running" : "done",
  role,
  content: {},
  source: {},
  orderSeq,
  revision: 1,
  contentHash: id,
  updatedSeq,
  createdAt: at(updatedSeq),
  updatedAt: at(updatedSeq),
  completedAt: type === "turn.start" ? null : at(updatedSeq),
  ...extra,
});

console.log("userMessageMatches:");
t("matching clientMessageId matches", () =>
  assert.equal(userMessageMatches(userItem("srv1", "anything", 0, "opt_42"), "opt_42"), true),
);
t("mismatched clientMessageId does NOT match", () =>
  assert.equal(userMessageMatches(userItem("srv1", "anything", 0, "opt_42"), "opt_99"), false),
);
t("real with no clientMessageId does NOT match", () =>
  assert.equal(userMessageMatches(userItem("srv1", "anything", 0), "opt_42"), false),
);
t("non-user role does NOT match", () =>
  assert.equal(
    userMessageMatches(
      { id: "a", type: "message", role: "assistant", content: { text: "x" }, source: { clientMessageId: "opt_42" }, createdAt: at(0) },
      "opt_42",
    ),
    false,
  ),
);
t("non-message type does NOT match", () =>
  assert.equal(
    userMessageMatches(
      { id: "a", type: "tool", role: "user", content: {}, source: { clientMessageId: "opt_42" }, createdAt: at(0) },
      "opt_42",
    ),
    false,
  ),
);

console.log("stripInjectedAttachmentMentions:");
t("strips a single file mention", () =>
  assert.equal(
    stripInjectedAttachmentMentions("总结下\n\n[Attached file: r.md (text/markdown, 100 bytes) at /p/r.md]"),
    "总结下",
  ),
);
t("file-only message strips to empty", () =>
  assert.equal(stripInjectedAttachmentMentions("\n\n[Attached file: x.pdf (application/pdf, 9 bytes) at /p]"), ""),
);
t("plain text untouched", () =>
  assert.equal(stripInjectedAttachmentMentions("just a normal message"), "just a normal message"),
);
t("strips from first of multiple mentions", () =>
  assert.equal(
    stripInjectedAttachmentMentions("hi\n\n[Attached file: a (t, 1 bytes) at /a]\n\n[Attached file: b (t, 1 bytes) at /b]"),
    "hi",
  ),
);

console.log("assignSentRecords:");
t("re-attaches refs to the real item via clientMessageId", () => {
  const real = [userItem("srv1", "总结下\n\n[Attached file: r.md (text/markdown, 100 bytes) at /p/r.md]", 800, "opt1")];
  const recs = [{ sentId: "opt1", text: "总结下", createdAt: at(0), attachments: [{ fileId: "file_a", name: "r.md", mediaType: "text/markdown", size: 100 }] }];
  const map = assignSentRecords(real, recs);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get("srv1"), [{ fileId: "file_a", name: "r.md", mediaType: "text/markdown", size: 100 }]);
});
t("skips real items that already carry attachments (optimistic)", () => {
  const real = [{ id: "opt", type: "message", role: "user", content: { text: "x", attachments: [{ fileId: "file_a" }] }, source: { clientMessageId: "opt1" }, createdAt: at(0) }];
  const recs = [{ sentId: "opt1", text: "x", createdAt: at(0), attachments: [{ fileId: "file_a", name: "r.md", mediaType: "text/markdown", size: 100 }] }];
  assert.equal(assignSentRecords(real, recs).size, 0);
});
t("two reals with distinct clientMessageIds get their own records", () => {
  const real = [userItem("s1", "hi", 100, "o1"), userItem("s2", "hi", 6000, "o2")];
  const recs = [
    { sentId: "o1", text: "hi", createdAt: at(0), attachments: [{ fileId: "file_a", name: "a", mediaType: "t", size: 1 }] },
    { sentId: "o2", text: "hi", createdAt: at(5900), attachments: [{ fileId: "file_b", name: "b", mediaType: "t", size: 1 }] },
  ];
  const map = assignSentRecords(real, recs);
  assert.equal(map.size, 2);
  assert.equal(map.get("s1")[0].fileId, "file_a");
  assert.equal(map.get("s2")[0].fileId, "file_b");
});
t("record with no matching real (by id) is not assigned", () => {
  const real = [userItem("s1", "hi", 0, "different_id")];
  const recs = [{ sentId: "o1", text: "hi", createdAt: at(0), attachments: [{ fileId: "file_a", name: "a", mediaType: "t", size: 1 }] }];
  assert.equal(assignSentRecords(real, recs).size, 0);
});
t("real with no clientMessageId is not assigned even if text matches", () => {
  const real = [userItem("s1", "hi", 0)];
  const recs = [{ sentId: "o1", text: "hi", createdAt: at(0), attachments: [{ fileId: "file_a", name: "a", mediaType: "t", size: 1 }] }];
  assert.equal(assignSentRecords(real, recs).size, 0);
});

console.log("extractAttachments:");
t("parses attachment array from content", () =>
  assert.deepEqual(extractAttachments({ attachments: [{ fileId: "file_a", name: "x", size: 3, mediaType: "image/png" }] }), [
    { fileId: "file_a", name: "x", size: 3, mediaType: "image/png" },
  ]),
);
t("returns [] when no attachments", () => assert.deepEqual(extractAttachments({ text: "hi" }), []));

console.log("mergeOptimisticTimelineItems:");
t("anchors optimistic user after its running turn start", () => {
  const real = [
    timelineItem("turn_1:start", "turn.start", null, "turn_1", 1, 10),
    timelineItem("assistant_1", "message", "assistant", "turn_1", 2, 11, { content: { text: "working" } }),
    timelineItem("tool_1", "tool", "tool", "turn_1", 3, 12),
  ];
  const opt = timelineItem("opt_1", "message", "user", "turn_1", Number.MAX_SAFE_INTEGER, 0, {
    status: "running",
    content: { text: "do it" },
  });
  assert.deepEqual(
    mergeOptimisticTimelineItems(real, [opt]).map((item) => item.id),
    ["turn_1:start", "opt_1", "assistant_1", "tool_1"],
  );
});
t("dedupes optimistic user once real item carries clientMessageId", () => {
  const real = [
    timelineItem("turn_1:start", "turn.start", null, "turn_1", 1, 10),
    timelineItem("real_user", "message", "user", "turn_1", 2, 11, {
      content: { text: "do it" },
      source: { clientMessageId: "opt_1" },
    }),
    timelineItem("assistant_1", "message", "assistant", "turn_1", 3, 12),
  ];
  const opt = timelineItem("opt_1", "message", "user", "turn_1", Number.MAX_SAFE_INTEGER, 0, {
    status: "running",
    content: { text: "do it" },
  });
  assert.deepEqual(
    mergeOptimisticTimelineItems(real, [opt]).map((item) => item.id),
    ["turn_1:start", "real_user", "assistant_1"],
  );
});
t("keeps unanchored optimistic items at the end", () => {
  const real = [timelineItem("assistant_1", "message", "assistant", "turn_1", 1, 10)];
  const opt = timelineItem("opt_1", "message", "user", null, Number.MAX_SAFE_INTEGER, 0, {
    status: "pending",
    content: { text: "do it" },
  });
  assert.deepEqual(
    mergeOptimisticTimelineItems(real, [opt]).map((item) => item.id),
    ["assistant_1", "opt_1"],
  );
});

console.log(`\nALL ${pass} ASSERTIONS PASSED`);
