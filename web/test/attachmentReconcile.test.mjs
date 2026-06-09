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

console.log(`\nALL ${pass} ASSERTIONS PASSED`);
