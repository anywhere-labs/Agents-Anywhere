import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { registerSource } from "./helpers/onboarding-source.mjs"

const nextHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "next/dynamic" ? "next/dynamic.js" : specifier, context)
  },
})
const sourceHook = registerSource()
const { createElement: h } = await import("react")
const { renderToStaticMarkup } = await import("react-dom/server")
const { NextIntlClientProvider } = await import("next-intl")
const { TimelineEntry } = await import("../src/components/session/session-timeline-entry.tsx")
const { sessionIdOfContentPath } = await import("../src/lib/transport/content-transport.ts")
sourceHook.deregister()
nextHook.deregister()

const messages = JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8"))

function render(item) {
  return renderToStaticMarkup(h(NextIntlClientProvider, { locale: "zh-CN", messages, timeZone: "UTC" },
    h(TimelineEntry, {
      token: "test", session: { id: "session", runtime: "codex" },
      item: { id: "i", status: "done", source: {}, ...item },
      resolvingNoticeId: null, resolvingActionId: null, onRespondInteraction() {},
    }),
  ))
}

test("collab timeline: a supervision digest renders as a notice card, not the user's bubble", () => {
  const html = render({ type: "message", role: "user", content: { text: "turn_end on t1\nsummary", author: { kind: "supervision", sessionId: null, deviceId: null, supervisionId: "sv1" } } })
  assert.match(html, /监督通知/)
  assert.match(html, /collab-supervision-notice/)
  assert.match(html, /turn_end on t1/)
  assert.doesNotMatch(html, /rounded-2xl bg-secondary/)
})

test("collab timeline: an Agent-sent message names the sending session", () => {
  const html = render({ type: "message", role: "user", content: { text: "do it", author: { kind: "agent", sessionId: "sess_parent_1234", deviceId: null, supervisionId: null } } })
  assert.match(html, /collab-author/)
  assert.match(html, /由/)
  assert.match(html, /会话 sess_par…/)
  assert.match(html, /的 Agent 发送/)
})

test("collab timeline: an escalation renders the decision card", () => {
  const html = render({ type: "system", role: "system", content: { kind: "collab_escalation", question: "要合并吗？", context: "测试都过了", fromSessionId: "s1", targetSessionId: "s2" } })
  assert.match(html, /需要你决定/)
  assert.match(html, /要合并吗？/)
  assert.match(html, /测试都过了/)
  assert.match(html, /来自/)
  assert.match(html, /涉及/)
})

test("collab timeline: collaboration tools get Chinese labels", () => {
  assert.match(render({ type: "tool", role: "tool", content: { kind: "mcp", collabTool: { tool: "aa_spawn", sessionId: "s9" } } }), /协作 · 新建会话/)
  assert.match(render({ type: "tool", role: "tool", content: { kind: "mcp", collabTool: { tool: "aa_escalate" } } }), /协作 · 交给人决定/)
  assert.match(render({ type: "tool", role: "tool", content: { kind: "mcp", collabTool: { tool: "aa_unknown" } } }), /协作 · aa_unknown/)
})

test("collab routes belong to the supervisor session, so encrypted mode sends them through its device's channel", () => {
  assert.equal(sessionIdOfContentPath("/api/v2/sessions/s1/collab"), "s1")
  assert.equal(sessionIdOfContentPath("/api/v2/sessions/s1/collab/supervisions/sv1"), "s1")
  assert.equal(sessionIdOfContentPath("/api/v2/agent-collaboration/settings"), null)
})
