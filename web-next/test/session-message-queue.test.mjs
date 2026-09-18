import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act, useState } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { SessionMessageQueue } = await import("../src/components/session/session-message-queue.tsx")
const { enqueueMessage, readMessageQueue, subscribeMessageQueue, emptyMessageQueue } = await import("../src/components/session/message-queue.ts")
hooks.deregister()
const { useSyncExternalStore } = await import("react")
const messages = JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url)))

async function renderQueue(t, sessionId, contents = ["原文字"], options = {}) {
  const sends = []
  contents.forEach((content, index) => {
    enqueueMessage(sessionId, { id: index === 0 ? "message" : `message-${index}`, content, attachments: [], selections: {}, status: options.status ?? "queued" })
  })
  function Fixture() {
    const queue = useSyncExternalStore(subscribeMessageQueue, () => readMessageQueue(sessionId), emptyMessageQueue)
    return h(NextIntlClientProvider, { locale: "zh-CN", messages }, h(SessionMessageQueue, { sessionId, messages: queue, paused: options.paused ?? false, canSendNow: true, onSendNow: id => sends.push(id) }))
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(Fixture)))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { container, sends }
}

async function click(container, name) {
  // Action buttons are icon-only now, so match the accessible name first and fall back to visible text.
  const button = [...container.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === name || button.textContent === name)
  assert.ok(button, `Missing button: ${name}`)
  await act(async () => button.click())
}

async function type(container, value) {
  const input = container.querySelector("textarea")
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(input, value)
    input.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
}

test("clicking a queued message edits text with save and cancel; cancel discards and save persists", async t => {
  const { container } = await renderQueue(t, "ui-edit")
  await click(container, "原文字")
  assert.equal(container.querySelector("textarea").getAttribute("aria-label"), "修改文字")
  await type(container, "取消的修改")
  await click(container, "取消")
  assert.equal(readMessageQueue("ui-edit")[0].content, "原文字")
  await click(container, "原文字")
  await type(container, "保存的修改")
  await click(container, "保存")
  assert.equal(container.querySelector("textarea"), null)
  assert.equal(readMessageQueue("ui-edit")[0].content, "保存的修改")
})

test("send now targets the selected message and delete immediately removes it", async t => {
  const { container, sends } = await renderQueue(t, "ui-actions")
  await click(container, "立即发送")
  assert.deepEqual(sends, ["message"])
  await click(container, "删除")
  assert.deepEqual(readMessageQueue("ui-actions"), [])
  assert.equal(container.textContent, "")
})

test("several queued messages collapse into a count and open on demand", async t => {
  const { container } = await renderQueue(t, "ui-collapse", ["第一条消息", "第二条消息"])
  assert.equal(container.textContent.includes("2 条排队消息"), true)
  assert.equal(container.textContent.includes("第一条消息"), false)
  await click(container, "展开排队消息")
  assert.equal(container.textContent.includes("第一条消息"), true)
  assert.equal(container.textContent.includes("第二条消息"), true)
  await click(container, "收起排队消息")
  assert.equal(container.textContent.includes("第一条消息"), false)
})

test("a single queued message stays visible without a header", async t => {
  const { container } = await renderQueue(t, "ui-single", ["只有一条"])
  assert.equal(container.textContent.includes("只有一条"), true)
  assert.equal(container.textContent.includes("条排队消息"), false)
})

test("a paused queue keeps its header and says so, even for one message", async t => {
  const { container } = await renderQueue(t, "ui-paused", ["只有一条"], { paused: true })
  assert.equal(container.textContent.includes("队列已暂停"), true)
  assert.equal(container.textContent.includes("1 条排队消息"), true)
})

test("a failed message has no separate retry control; send now covers it", async t => {
  const { container } = await renderQueue(t, "ui-failed", ["失败的那条"], { status: "failed" })
  const labels = [...container.querySelectorAll("button")].map(button => button.getAttribute("aria-label")).filter(Boolean)
  assert.equal(labels.includes("重试"), false)
  assert.equal(labels.includes("立即发送"), true)
  assert.equal(container.textContent.includes("失败的那条"), true)
})

test("a paused queue locks send now until the queue resumes", async t => {
  const { container } = await renderQueue(t, "ui-paused-lock", ["卡住的那条"], { paused: true })
  await click(container, "展开排队消息")
  assert.equal(container.querySelector('button[aria-label="立即发送"]').disabled, true)
  const { container: running } = await renderQueue(t, "ui-paused-unlocked", ["可以发的"])
  assert.equal(running.querySelector('button[aria-label="立即发送"]').disabled, false)
})

test("adding another message keeps an active draft mounted and prevents collapse until saved", async t => {
  const sessionId = "ui-edit-append"
  const { container } = await renderQueue(t, sessionId)
  await click(container, "原文字")
  await type(container, "未保存的修改")
  const editor = container.querySelector("textarea")
  await act(async () => enqueueMessage(sessionId, { id: "second", content: "第二条", attachments: [], selections: {}, status: "queued" }))
  assert.equal(container.querySelector("textarea"), editor)
  assert.equal(editor.value, "未保存的修改")
  assert.equal(readMessageQueue(sessionId)[0].editing, true)
  assert.equal(container.querySelector('button[aria-label="收起排队消息"]').disabled, true)
  await click(container, "收起排队消息")
  assert.equal(container.querySelector("textarea"), editor)
  await click(container, "保存")
  assert.equal(readMessageQueue(sessionId)[0].content, "未保存的修改")
  assert.equal(readMessageQueue(sessionId)[0].editing, false)
  await click(container, "展开排队消息")
  assert.equal(container.textContent.includes("未保存的修改"), true)
})

test("manual collapse is disabled during editing and works after cancelling", async t => {
  const { container } = await renderQueue(t, "ui-edit-collapse", ["第一条", "第二条"])
  await click(container, "展开排队消息")
  await click(container, "第一条")
  await type(container, "临时草稿")
  await click(container, "收起排队消息")
  assert.equal(container.querySelector("textarea").value, "临时草稿")
  await click(container, "取消")
  await click(container, "收起排队消息")
  assert.equal(container.querySelector('[aria-expanded="false"]') !== null, true)
  assert.equal(readMessageQueue("ui-edit-collapse")[0].content, "第一条")
})
