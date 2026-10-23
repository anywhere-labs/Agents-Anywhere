import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"

import { registerSource } from "./helpers/onboarding-source.mjs"
import { groupModelOptions, modelSectionRows } from "../src/components/session/catalog-selection.ts"

const model = (id, group) => ({ id, label: id.toUpperCase(), group })
const sectionShape = (sections) => sections.map((section) => ({
  id: section.id,
  displayName: section.displayName,
  items: section.items.map((item) => item.id),
}))

test("model groups: fewer than two groups stay one flat headerless section in catalog order", () => {
  assert.deepEqual(sectionShape(groupModelOptions([])), [{ id: null, displayName: null, items: [] }])

  // Codex / Claude: no groups at all.
  assert.deepEqual(sectionShape(groupModelOptions([model("a", null), model("b", undefined), model("c", null)])), [
    { id: null, displayName: null, items: ["a", "b", "c"] },
  ])

  // A single provider (with stray ungrouped rows) is not worth a header either.
  const relay = { id: "relay", displayName: "Relay" }
  assert.deepEqual(sectionShape(groupModelOptions([model("a", relay), model("b", null), model("c", relay)])), [
    { id: null, displayName: null, items: ["a", "b", "c"] },
  ])
})

test("model groups: two interleaved groups follow first appearance and keep catalog order inside", () => {
  const deepseek = { id: "deepseek", displayName: "DeepSeek" }
  const relay = { id: "relay", displayName: "My Relay" }
  const sections = groupModelOptions([
    model("r1", relay),
    model("d1", deepseek),
    model("r2", relay),
    model("d2", deepseek),
    model("r3", relay),
  ])
  assert.deepEqual(sectionShape(sections), [
    { id: "relay", displayName: "My Relay", items: ["r1", "r2", "r3"] },
    { id: "deepseek", displayName: "DeepSeek", items: ["d1", "d2"] },
  ])
  // Items are passed through untouched, so row labels stay what they were.
  assert.equal(sections[0].items[0].label, "R1")
})

test("model groups: ungrouped models trail in a final headerless section", () => {
  const a = { id: "a", displayName: "A" }
  const b = { id: "b", displayName: "B" }
  assert.deepEqual(sectionShape(groupModelOptions([
    model("x1", null),
    model("a1", a),
    model("x2", undefined),
    model("b1", b),
    model("a2", a),
  ])), [
    { id: "a", displayName: "A", items: ["a1", "a2"] },
    { id: "b", displayName: "B", items: ["b1"] },
    { id: null, displayName: null, items: ["x1", "x2"] },
  ])
})

test("model groups: a repeated group id keeps the first display name", () => {
  assert.deepEqual(sectionShape(groupModelOptions([
    model("a1", { id: "a", displayName: "First name" }),
    model("b1", { id: "b", displayName: "B" }),
    model("a2", { id: "a", displayName: "Renamed" }),
  ])), [
    { id: "a", displayName: "First name", items: ["a1", "a2"] },
    { id: "b", displayName: "B", items: ["b1"] },
  ])
})

test("model rows: under a provider header the row drops the provider; flat lists keep the label", () => {
  const item = (id, label, group) => ({ id, label, group })
  const grouped = groupModelOptions([
    item("d1", "v4（DeepSeek）", { id: "deepseek", displayName: "DeepSeek", itemDisplayName: "v4" }),
    item("r1", "v4（Relay）", { id: "relay", displayName: "Relay", itemDisplayName: "v4" }),
    item("d2", "v4-flash", { id: "deepseek", displayName: "DeepSeek" }),
  ])
  assert.deepEqual(grouped.map((section) => modelSectionRows(section).map((row) => row.label)), [["v4", "v4-flash"], ["v4"]])
  // The catalog item itself is untouched, so the selected-model label keeps the provider.
  assert.equal(grouped[0].items[0].label, "v4（DeepSeek）")
  const flat = groupModelOptions([item("d1", "v4（DeepSeek）", { id: "deepseek", displayName: "DeepSeek", itemDisplayName: "v4" })])
  assert.deepEqual(modelSectionRows(flat[0]).map((row) => row.label), ["v4（DeepSeek）"])
})

test("selection drawer shows provider headers for a two-group catalog", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test/", pretendToBeVisual: true })
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DocumentFragment", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.matchMedia = dom.window.matchMedia
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const hook = registerSource()
  const { createElement: h, act } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { SelectionSettingsDrawer } = await import("../src/components/session/selection-settings-drawer.tsx")
  hook.deregister()

  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })

  const deepseek = { id: "deepseek", displayName: "DeepSeek" }
  const relay = { id: "relay", displayName: "My Relay" }
  // d1 and r1 share a model name; the catalog label carries the provider, the row does not.
  const modelItems = [
    { id: "d1", label: "deepseek-v4（DeepSeek）", group: { ...deepseek, itemDisplayName: "deepseek-v4" }, reasoningItems: [] },
    { id: "r1", label: "deepseek-v4（My Relay）", group: { ...relay, itemDisplayName: "deepseek-v4" }, reasoningItems: [] },
    { id: "d2", label: "DeepSeek Reasoner", group: deepseek, reasoningItems: [] },
  ]
  await act(async () => root.render(h(SelectionSettingsDrawer, {
    requestOpenKey: 1,
    buttonLabel: "Settings",
    title: "Settings",
    permissionLabel: "Permission",
    modelLabel: "Model",
    reasoningLabel: "Reasoning",
    permissionItems: [],
    selectedPermission: "",
    onPermissionChange() {},
    modelItems,
    selectedModel: "d1",
    selectedReasoning: "",
    onModelChange() {},
  })))

  const groups = [...document.querySelectorAll('[role="group"]')]
  assert.deepEqual(groups.map((group) => group.getAttribute("aria-label")), ["DeepSeek", "My Relay"])
  assert.deepEqual(
    groups.map((group) => [...group.querySelectorAll("button")].map((button) => button.textContent)),
    [["deepseek-v4", "DeepSeek Reasoner"], ["deepseek-v4"]],
  )
  // Headers are labels, not selectable rows.
  const buttonTexts = [...document.querySelectorAll("button")].map((button) => button.textContent)
  assert.ok(!buttonTexts.includes("DeepSeek"))
  assert.ok(!buttonTexts.includes("My Relay"))
})
