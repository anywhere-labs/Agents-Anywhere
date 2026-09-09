import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { RuntimeAddDialog } = await import("../src/components/runtime-add-dialog.tsx")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
hooks.deregister()

function typeFor(runtimeType) {
  return {
    connectorId: "conn_fixture", runtimeType,
    displayName: { codex: "Codex", claude: "Claude", dsh: "DeepSeek Harness" }[runtimeType],
    available: true, present: true, instancePolicy: "single", maxInstances: 1,
    schema: { type: "object", properties: { customPath: { type: "string", title: "Custom path" } } },
    uiSchema: {}, defaults: { customPath: "/default" },
  }
}

function instance(runtimeType, extra = {}) {
  return {
    connectorId: "conn_fixture", runtimeType, runtimeId: `rti_${runtimeType}`,
    name: typeFor(runtimeType).displayName, configured: false, active: false,
    config: null, status: "stopped", ...extra,
  }
}

async function render(t, { runtimeType = "codex", initialRuntimes = [], locale = "zh-CN", reason = null } = {}) {
  let inventory = [...initialRuntimes]
  const calls = []
  const updates = []
  const result = { closed: false, calls, updates, setInventory: (value) => { inventory = value } }
  t.mock.method(dashboardApi, "getConnectorRuntimes", async () => ({ runtimes: inventory }))
  t.mock.method(dashboardApi, "createConnectorRuntime", async (_token, _connector, payload) => {
    calls.push({ action: "create", ...payload })
    const added = instance(runtimeType, { ...payload, configured: true, status: "running" })
    inventory.push(added)
    return added
  })
  t.mock.method(dashboardApi, "renameConnectorRuntime", async (_token, _connector, id, name) => {
    calls.push({ action: "rename", id, name })
    const changed = { ...inventory.find((runtime) => runtime.runtimeId === id), name }
    inventory = inventory.map((runtime) => runtime.runtimeId === id ? changed : runtime)
    return changed
  })
  t.mock.method(dashboardApi, "putConnectorRuntimeConfig", async (_token, _connector, id, config) => {
    calls.push({ action: "configure", id, config })
    const changed = { ...inventory.find((runtime) => runtime.runtimeId === id), config, configured: true }
    inventory = inventory.map((runtime) => runtime.runtimeId === id ? changed : runtime)
    return changed
  })
  t.mock.method(dashboardApi, "setConnectorRuntimeActive", async (_token, _connector, id, active) => {
    calls.push({ action: "activate", id, active })
    return { ...inventory.find((runtime) => runtime.runtimeId === id), active, status: "running" }
  })
  const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"))
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale, messages, timeZone: "Asia/Shanghai" }, h(RuntimeAddDialog, {
    runtimeType: { ...typeFor(runtimeType), reason }, runtimes: initialRuntimes,
    token: "fixture-token", connectorId: "conn_fixture",
    onOpenChange: (open) => { result.closed = !open },
    onRuntimeUpdated: (runtime) => updates.push(runtime),
  }))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  if (process.env.AA_RUNTIME_ADD_QA_DIR) {
    mkdirSync(process.env.AA_RUNTIME_ADD_QA_DIR, { recursive: true })
    writeFileSync(`${process.env.AA_RUNTIME_ADD_QA_DIR}/${runtimeType}-${locale}-${reason ? "unsupported" : "ready"}.html`, document.body.innerHTML)
  }
  return result
}

function button(label) {
  const found = [...document.querySelectorAll("button")].find((node) => node.textContent === label)
  assert.ok(found, `Missing button ${label}`)
  return found
}

async function click(label) {
  const node = button(label)
  assert.equal(node.disabled, false)
  await act(async () => node.click())
}

async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value)
    input.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
}

for (const runtimeType of ["codex", "claude", "dsh"]) {
  for (const cleared of [false, true]) {
    test(`${runtimeType}: ${cleared ? "cleared" : "new"} instances use the same name and actions dialog`, async (t) => {
      const initialRuntimes = cleared ? [instance(runtimeType)] : []
      const state = await render(t, { runtimeType, initialRuntimes })
      const name = runtimeType === "dsh" ? "DSH" : typeFor(runtimeType).displayName
      assert.equal(document.querySelector("[role=dialog] input").value, name)
      assert.equal(button("快速添加").dataset.variant, "default")
      assert.equal(button("配置").dataset.variant, "outline")
      assert.equal(button("取消").dataset.variant, "ghost")
      assert.deepEqual(state.calls, [])
      await fill(document.querySelector("input"), `${name} Work`)
      await click("快速添加")
      assert.equal(state.closed, true)
      if (cleared) {
        assert.deepEqual(state.calls, [
          { action: "rename", id: `rti_${runtimeType}`, name: `${name} Work` },
          { action: "configure", id: `rti_${runtimeType}`, config: {} },
          { action: "activate", id: `rti_${runtimeType}`, active: true },
        ])
      } else {
        assert.deepEqual(state.calls, [{ action: "create", runtimeType, name: `${name} Work`, config: {}, active: true }])
      }
    })
  }
}

test("Configure preserves the name and only creates after saving the edited settings", async (t) => {
  const state = await render(t)
  await fill(document.querySelector("input"), "My Codex")
  await click("配置")
  assert.deepEqual(state.calls, [])
  assert.match(document.querySelector("[role=dialog]").textContent, /配置 My Codex/)
  await fill(document.querySelector("[role=dialog] input"), "/chosen")
  await click("配置并启动")
  assert.equal(state.closed, true)
  assert.deepEqual(state.calls, [{ action: "create", runtimeType: "codex", name: "My Codex", config: { customPath: "/chosen" }, active: true }])
})

test("Cancel writes nothing, and empty names cannot take either add path", async (t) => {
  const state = await render(t)
  await fill(document.querySelector("input"), "  ")
  assert.equal(button("快速添加").disabled, true)
  assert.equal(button("配置").disabled, true)
  await click("取消")
  assert.equal(state.closed, true)
  assert.deepEqual(state.calls, [])
})

test("cancelling configuration returns to the chosen name without writing an instance", async (t) => {
  const state = await render(t, { runtimeType: "dsh" })
  await fill(document.querySelector("input"), "DSH Work")
  await click("配置")
  await click("取消")
  assert.equal(document.querySelector("input").value, "DSH Work")
  assert.ok(button("快速添加"))
  assert.equal(state.closed, false)
  assert.deepEqual(state.calls, [])
})

test("names already in use cannot configure or overwrite another instance", async (t) => {
  const state = await render(t, { initialRuntimes: [instance("claude", { name: "Work", configured: true })] })
  await fill(document.querySelector("input"), "work")
  await click("快速添加")
  assert.match(document.querySelector("[role=alert]").textContent, /名称已被使用/)
  await click("配置")
  assert.ok(button("快速添加"))
  assert.equal(state.closed, false)
  assert.deepEqual(state.calls, [])
})

test("a pending quick add cannot be submitted twice or dismissed", async (t) => {
  const state = await render(t)
  let complete
  let creates = 0
  t.mock.method(dashboardApi, "createConnectorRuntime", async () => {
    creates += 1
    return await new Promise((resolve) => { complete = resolve })
  })
  await act(async () => {
    const primary = button("快速添加")
    primary.click()
    primary.click()
  })
  assert.equal(creates, 1)
  assert.equal(document.querySelector("input").disabled, true)
  for (const label of ["快速添加", "配置", "取消"]) assert.equal(button(label).disabled, true)
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  assert.equal(state.closed, false)
  await act(async () => complete(instance("codex", { name: "Codex", configured: true, active: true, status: "running" })))
  assert.equal(state.closed, true)
})

test("a configuration save failure preserves the draft and can be retried", async (t) => {
  const state = await render(t, { initialRuntimes: [instance("codex")] })
  const save = dashboardApi.putConnectorRuntimeConfig
  t.mock.method(dashboardApi, "putConnectorRuntimeConfig", async (...args) => {
    if (state.calls.length === 0) {
      state.calls.push({ action: "failed-configure" })
      throw new Error("Configuration could not be saved")
    }
    return save(...args)
  })
  await click("配置")
  await fill(document.querySelector("[role=dialog] input"), "/chosen")
  await click("配置并启动")
  assert.equal(state.closed, false)
  assert.equal(document.querySelector("[role=dialog] input").value, "/chosen")
  assert.deepEqual(state.calls, [{ action: "failed-configure" }])
  await click("配置并启动")
  assert.equal(state.closed, true)
  assert.deepEqual(state.calls.slice(1), [
    { action: "configure", id: "rti_codex", config: { customPath: "/chosen" } },
    { action: "activate", id: "rti_codex", active: true },
  ])
})

test("failed quick add keeps the name and can configure the persisted instance before retrying", async (t) => {
  const state = await render(t)
  let creates = 0
  t.mock.method(dashboardApi, "createConnectorRuntime", async (_token, _connector, payload) => {
    creates += 1
    state.setInventory([instance("codex", { ...payload, configured: true, status: "error" })])
    throw new Error("Please configure the runtime path")
  })
  await fill(document.querySelector("input"), "Work")
  await click("快速添加")
  assert.equal(state.closed, false)
  assert.equal(document.querySelector("input").value, "Work")
  assert.match(document.querySelector("[role=alert]").textContent, /configure the runtime path/)
  await fill(document.querySelector("input"), "Work Fixed")
  await click("配置")
  await fill(document.querySelector("[role=dialog] input"), "/fixed")
  await click("配置并启动")
  assert.equal(creates, 1)
  assert.equal(state.closed, true)
  assert.equal(state.calls.at(-1).action, "activate")
  assert.equal(state.updates.at(-1).name, "Work Fixed")
})

test("the English dialog exposes the same actions and unsupported runtime guidance", async (t) => {
  await render(t, { runtimeType: "dsh", locale: "en", reason: "This connector does not support DeepSeek Harness." })
  assert.equal(document.querySelector("input").value, "DSH")
  assert.equal(button("Quick add").dataset.variant, "default")
  assert.equal(button("Configure").dataset.variant, "outline")
  assert.ok(button("Cancel"))
  assert.match(document.querySelector("[role=alert]").textContent, /does not support DeepSeek Harness/)
})
