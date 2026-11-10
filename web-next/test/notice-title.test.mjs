import assert from "node:assert/strict"
import test from "node:test"
import { noticeTitleKey } from "../src/components/session/notice-title.ts"

const codex = kind => ({ noticeId: "notice_approval_a1", interactionType: "approval", context: { kind, approvalSource: { method: "x" } } })

test("notice titles: Codex and Claude approvals map by structured kind, not English text", () => {
  assert.equal(noticeTitleKey(codex("command")), "approvalTitle_codex_command")
  assert.equal(noticeTitleKey(codex("file_change")), "approvalTitle_codex_file_change")
  assert.equal(noticeTitleKey(codex("permissions")), "approvalTitle_codex_permissions")
  assert.equal(noticeTitleKey({ noticeId: "notice_claude_approval_x", interactionType: "approval", context: {} }), "approvalTitle_claude_tool")
})

test("notice titles: other notices keep the runtime's own title", () => {
  assert.equal(noticeTitleKey(codex("approval")), null)
  assert.equal(noticeTitleKey({ noticeId: "n", interactionType: "input_request", context: { kind: "command", approvalSource: {} } }), null)
  assert.equal(noticeTitleKey({ noticeId: "n", interactionType: "approval", context: { kind: "command" } }), null)
})
