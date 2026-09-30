import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import vm from "node:vm"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { JSDOM } from "jsdom"
import ts from "typescript"

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL("../src/components/session/session-plan-review-card.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText
const messages = JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8")).dashboard.session
const openedPlans = []
const { createPlanDraft } = await import("../src/components/session/plan-draft.ts")
const drafts = new Map()
const stubs = {
  "@/components/session/session-file-preview-context": { useSessionFilePreviewOpener: () => target => openedPlans.push(target), usePlanDraft: (id, text) => { if (!drafts.has(id)) drafts.set(id, createPlanDraft(text)); return drafts.get(id) } },
  "next-intl": { useTranslations: () => key => messages[key] },
  "@/components/markdown-text": { MarkdownText: ({ text }) => React.createElement("article", { "data-plan-body": true }, text) },
  "@/components/ui/button": { Button: ({ variant: _variant, ...props }) => React.createElement("button", props) },
  // onInput lets jsdom exercise the same callback without React's browser input polyfill.
  "@/components/ui/textarea": { Textarea: ({ onChange, ...props }) => React.createElement("textarea", { ...props, onChange: () => {}, onInput: onChange }) },
}
const context = vm.createContext({ exports: {}, require: name => stubs[name] ?? require(name) })
vm.runInContext(source, context)

const notice = {
  noticeId: "plan-1", source: { component: "claude.plan_review" },
  message: "# 计划\n\n1. 添加测试\n2. 修复实现", status: "open", responseRequired: true,
  context: { automatedPermissionMode: "acceptEdits" },
  actions: ["approve_automated", "approve_manual", "revise_plan"].map(actionId => ({ actionId })),
}

test("edited plan is shared with the sidebar and approval uses the latest draft", async () => {
  const { window } = new JSDOM('<div id="root"></div>')
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(window.document.getElementById("root"))
  const replies = []
  const render = (overrides = {}) => act(() => root.render(React.createElement(context.exports.PlanReviewCard, {
    notice, resolvingNoticeId: null, resolvingActionId: null,
    onRespondInteraction: (...args) => replies.push(args), ...overrides,
  })))
  try {
    await render()
    const button = label => [...window.document.querySelectorAll("button")].find(node => node.textContent.includes(label))
    const select = window.document.querySelector("select")
    assert.equal(select.value, "approve_manual")
    assert.equal(window.document.querySelector("textarea"), null)
    await act(() => window.document.querySelector('button[aria-label="查看完整计划"]').click())
    const draft = openedPlans.at(-1).planDraft
    assert.equal(draft.getSnapshot().text, notice.message)
    await act(() => draft.update({text: "# User edited plan"}))
    assert.equal(window.document.querySelector("article").textContent, "# User edited plan")
    await act(() => button("批准执行").click())
    assert.equal(JSON.stringify(replies.pop()), JSON.stringify(["plan-1", "approve_manual", {plan:"# User edited plan"}]))
    await act(() => {select.value = "approve_automated"; select.dispatchEvent(new window.Event("change", {bubbles:true}))})
    await act(() => button("批准执行").click())
    assert.equal(replies.pop()[1], "approve_automated")
    await act(() => draft.update({text:"  "}))
    assert.equal(button("批准执行").disabled, true)
    await act(() => draft.update({text:"# User edited plan"}))
    await act(() => button("让 Claude 继续修改").click())
    const textarea = window.document.querySelector("textarea")
    await act(() => {textarea.value = "  Add tests  "; textarea.dispatchEvent(new window.Event("input", {bubbles:true}))})
    await act(() => button("提交").click())
    assert.equal(JSON.stringify(replies.pop()), JSON.stringify(["plan-1", "revise_plan", {feedback:"Add tests",plan:"# User edited plan"}]))
    await render({resolvingNoticeId:"plan-1",resolvingActionId:"approve_manual"})
    assert.equal(button("批准执行").disabled, true)
    await render({notice:{...notice,status:"failed"}})
    assert.equal(draft.getSnapshot().text,"# User edited plan")
    await render({notice:{...notice,status:"resolved",responseRequired:false,actions:[]}})
    assert.equal(button("批准执行"),undefined)
    await act(() => draft.update({text:"# Edited after approval"}))
    assert.equal(window.document.querySelector("article").textContent,"# Edited after approval")
    assert.equal(replies.length,0)
    await render({notice:{...notice,noticeId:"codex-plan",source:{component:"codex.plan_review"}}})
    assert.equal(window.document.querySelector("select"), null)
    assert.ok(button("让 Codex 继续修改"))
    await act(() => button("批准执行").click())
    assert.equal(replies.pop()[1], "implement_plan")
    await act(() => root.unmount())
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    window.close()
  }
})
