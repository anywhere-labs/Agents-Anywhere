import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
HTMLElement.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { FileBreadcrumbPicker } = await import("../src/components/panels/file-breadcrumb-picker.tsx")
const { LazyFileTree } = await import("../src/components/panels/lazy-file-tree.tsx")
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))
const directory = { name: "src", path: "/repo/src", type: "directory" }
const sibling = { name: "docs", path: "/repo/docs", type: "directory" }
const file = { name: "a.ts", path: "/repo/src/a.ts", type: "file" }

async function mount(t, loadDirectory) {
  const selected = []
  const events = []
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "en", timeZone: "UTC", messages },
    h(FileBreadcrumbPicker, { path: directory.path, label: "src", current: true, directory: true,
      caseInsensitivePaths: false, loadDirectory,
      onBrowse: () => events.push("pin-current"),
      onSelect: (entry) => { selected.push(entry.path); events.push("open-preview") } }))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { selected, events, trigger: container.querySelector("button") }
}
const click = async (element) => { assert.ok(element); await act(async () => element.click()) }
const row = (path) => document.querySelector(`[data-fs-entry-path="${path}"]`)
const key = async (element, value) => act(async () => element.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true })))

test("expanding another directory does not scroll back to the breadcrumb selection", async t => {
  const scrolled = []
  t.mock.method(HTMLElement.prototype, "scrollIntoView", function () { scrolled.push(this.dataset.fsEntryPath) })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  const leaf = { name: "readme.md", path: "/repo/docs/readme.md", type: "file" }
  let resolveDirectory
  const props = {
    identity: "scroll-test", rootPath: "/repo", entries: [directory, sibling], canLoad: true,
    selectedPath: directory.path,
    labels: { empty: "empty", loading: "loading", noConnector: "offline", retry: "retry", truncated: "truncated" },
    loadDirectory: () => new Promise(resolve => { resolveDirectory = resolve }),
    onOpenFile() {},
  }
  const frame = () => act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)) })
  await act(async () => root.render(h(LazyFileTree, props)))
  await frame()
  assert.deepEqual(scrolled, [directory.path])
  await click(row(sibling.path))
  await frame()
  assert.deepEqual(scrolled, [directory.path])
  await act(async () => resolveDirectory({ path: sibling.path, entries: [leaf] }))
  await frame()
  assert.deepEqual(scrolled, [directory.path])
  assert.ok(row(leaf.path))
  await act(async () => root.render(h(LazyFileTree, { ...props, selectedPath: leaf.path })))
  await frame()
  assert.deepEqual(scrolled, [directory.path, leaf.path])
  await click(row(sibling.path))
  await frame()
  assert.deepEqual(scrolled, [directory.path, leaf.path])
})

test("scroll restoration waits for expanded siblings and runs only once", async t => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  const viewport = document.createElement("div")
  let restored = 0
  let top = 0
  Object.defineProperty(viewport, "scrollTop", { get: () => top, set: value => { restored++; top = value } })
  const scrolls = []
  t.mock.method(HTMLElement.prototype, "scrollIntoView", () => scrolls.push(true))
  let resolveDirectory
  const props = {
    identity: "restored-scroll", rootPath: "/repo", entries: [sibling, file], canLoad: true,
    selectedPath: file.path, initialExpandedPaths: [sibling.path],
    restoredScroll: { top: 650, left: 12 }, scrollViewportRef: { current: viewport },
    labels: { empty: "empty", loading: "loading", noConnector: "offline", retry: "retry", truncated: "truncated" },
    loadDirectory: () => new Promise(resolve => { resolveDirectory = resolve }), onOpenFile() {},
  }
  const frame = () => act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)) })
  await act(async () => root.render(h(LazyFileTree, props)))
  await frame()
  assert.equal(restored, 0)
  await act(async () => resolveDirectory({ path: sibling.path, entries: [] }))
  await frame()
  assert.equal(top, 650)
  assert.equal(viewport.scrollLeft, 12)
  assert.equal(restored, 1)
  assert.deepEqual(scrolls, [])
  top = 500
  await click(row(sibling.path))
  await frame()
  assert.equal(top, 500)
  assert.equal(restored, 1)
})

test("picker opens siblings, expands the current directory, and selects files", async (t) => {
  const calls = []
  const picker = await mount(t, async (path) => {
    calls.push(path)
    return { path, entries: path === "/repo" ? [directory, sibling] : [file] }
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(picker.events, [])
  await click(picker.trigger)
  assert.deepEqual(calls, ["/repo", "/repo/src"])
  assert.ok(row(sibling.path))
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "true")
  await click(row(file.path))
  assert.deepEqual(picker.selected, [file.path])
  assert.deepEqual(picker.events, ["pin-current", "open-preview"])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test("arrow keys, chevrons and Enter on directories expand without selecting", async (t) => {
  const picker = await mount(t, async (path) => ({ path, entries: path === "/repo" ? [directory, sibling] : [file] }))
  await click(picker.trigger)
  await key(row(directory.path), "ArrowLeft")
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "false")
  await key(row(directory.path), "ArrowRight")
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "true")
  await click(row(directory.path).querySelector("[data-tree-toggle]"))
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "false")
  assert.deepEqual(picker.selected, [])
  await key(row(sibling.path), "Enter")
  assert.equal(row(sibling.path).getAttribute("aria-expanded"), "true")
  assert.deepEqual(picker.selected, [])
  assert.ok(document.querySelector('[role="dialog"]'))
})

test("directory names allow browsing multiple levels before selecting a file", async (t) => {
  const nested = { name: "nested", path: "/repo/docs/nested", type: "directory" }
  const leaf = { name: "readme.md", path: "/repo/docs/nested/readme.md", type: "file" }
  const contents = {
    "/repo": [directory, sibling],
    "/repo/src": [file],
    "/repo/docs": [nested],
    "/repo/docs/nested": [leaf],
  }
  const picker = await mount(t, async (path) => ({ path, entries: contents[path] ?? [] }))
  await click(picker.trigger)
  await click(row(sibling.path).querySelector(".aa-file-tree-name"))
  await click(row(nested.path).querySelector(".aa-file-tree-name"))
  assert.ok(row(leaf.path))
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.deepEqual(picker.selected, [])
  await click(row(nested.path))
  assert.equal(row(leaf.path), null)
  await click(row(nested.path))
  await click(row(leaf.path))
  assert.deepEqual(picker.selected, [leaf.path])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test("closing a picker ignores its outstanding request after reopening", async (t) => {
  const pending = []
  const picker = await mount(t, (path) => new Promise((resolve) => pending.push({ path, resolve })))
  await click(picker.trigger)
  await click(picker.trigger)
  await click(picker.trigger)
  assert.equal(pending.length, 2)
  await act(async () => pending[1].resolve({ path: "/repo", entries: [sibling] }))
  await act(async () => pending[0].resolve({ path: "/repo", entries: [file] }))
  assert.ok(row(sibling.path))
  assert.equal(row(file.path), null)
})

test("file tree distinguishes a single-click preview from a double-click kept file", async (t) => {
  const opened = []
  const kept = []
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(h(LazyFileTree, {
    identity: "double-click-test", rootPath: "/repo/src", entries: [file], canLoad: true,
    labels: { empty: "empty", loading: "loading", noConnector: "offline", retry: "retry", truncated: "truncated" },
    loadDirectory: async () => ({ path: "/repo/src", entries: [] }),
    onOpenFile: (entry) => opened.push(entry.path),
    onKeepFileOpen: (entry) => kept.push(entry.path),
  })))
  const item = row(file.path)
  const mouse = (type, detail) => item.dispatchEvent(new window.MouseEvent(type, { bubbles: true, detail }))
  await act(async () => { mouse("click", 1); mouse("click", 2); mouse("dblclick", 2) })
  assert.deepEqual(kept, [file.path])
  assert.deepEqual(opened, [file.path])
  await act(async () => { mouse("click", 1) })
  assert.deepEqual(opened, [file.path, file.path])
  // Keyboard activation should not wait for a possible mouse double-click.
  await key(item, "Enter")
  assert.deepEqual(opened, [file.path, file.path, file.path])
})
