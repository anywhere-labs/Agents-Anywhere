import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import test from "node:test"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const { toast } = await import("sonner")

// Keep the actual sidebar, project lists, translations and toast UI. Only the
// account/device/API boundary is replaced; no login or real project is needed.
const sourceHooks = registerSource()
const fixtures = {
  "@/components/auth/auth-context": "export const useAuth = () => globalThis.folderDropFixture.auth",
  "@/components/workspace-context": "export const useWorkspace = () => globalThis.folderDropFixture.workspace",
  "@/features/desktop/desktop-connector-context": "export const useDesktopConnector = () => globalThis.folderDropFixture.desktop",
  "@/components/pair-device-dialog": "export const PairDeviceDialog = () => null",
}
const fixtureHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (fixtures[specifier]) return { url: `data:text/javascript,${encodeURIComponent(fixtures[specifier])}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const { AppSidebar } = await import("../src/components/app-sidebar.tsx")
const { SidebarProvider } = await import("../src/components/ui/sidebar.tsx")
const { ToasterProvider } = await import("../src/components/toaster-provider.tsx")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
fixtureHooks.deregister()
sourceHooks.deregister()

const connector = { id: "local", name: "This Mac", status: "online", deviceOs: "macos" }
const project = { id: "existing", name: "My project", connectorId: "local", workspacePath: "/work/project", manuallyCreated: true, pinned: false, createdAt: "2026-10-20T00:00:00Z", activeSessionCount: 0 }

async function render(t, { locale = "zh-CN", projects = [], folder = "/work/project", online = true, desktop = true } = {}) {
  const calls = { paths: [], lists: 0, creates: [], view: null }
  globalThis.folderDropFixture = {
    auth: { session: { accessToken: "fixture-token", userId: "fixture-user" }, me: null, signOut() {} },
    desktop: { supported: desktop, binding: { connectorId: "local" }, state: null, isLocalConnector: id => id === "local" },
    workspace: {
      connectors: [{ ...connector, status: online ? "online" : "offline" }], projects, sessions: [], isLoading: false,
      filter: { connectorId: "all", runtime: "all", status: "all" }, search: "", page: "home", sidebarShowsSessions: true,
      setFilter() {}, setSidebarShowsSessions: value => { calls.view = value },
      createProject: async payload => { calls.creates.push(payload); return { ...project, ...payload } },
    },
  }
  window.desktopWorkbench = desktop ? { files: { droppedFolderPath: async file => { calls.paths.push(file.name); return folder } } } : undefined
  t.mock.method(dashboardApi, "listProjects", async () => { calls.lists++; return { projects } })
  const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"))
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale, messages, timeZone: "Asia/Shanghai" },
    h(SidebarProvider, null, h(AppSidebar, { contained: true }), h(ToasterProvider)),
  )))
  t.after(async () => {
    await act(async () => { toast.dismiss(); await new Promise(resolve => setTimeout(resolve, 5)) })
    await act(async () => root.unmount())
    container.remove()
    delete window.desktopWorkbench
  })
  return { calls, container, messages: messages.dashboard.projects }
}

async function drag(container, type, names = ["project"], types = ["Files"], entries = []) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  const files = names.map(name => new window.File([], name))
  const items = entries.map(entry => ({ kind: "file", webkitGetAsEntry: () => entry }))
  Object.defineProperty(event, "dataTransfer", { value: { types, files, items, dropEffect: "none" } })
  await act(async () => {
    container.querySelector('[data-slot="sidebar-header"]').dispatchEvent(event)
    await new Promise(resolve => setTimeout(resolve, 10))
  })
  return event
}

for (const locale of ["zh-CN", "en"]) {
  test(`${locale}: dropping an existing manual project displays the duplicate message without creating`, async t => {
    const { calls, container, messages } = await render(t, { locale, projects: [project] })
    const event = await drag(container, "drop")
    assert.equal(event.defaultPrevented, true)
    const notification = container.querySelector("[data-sonner-toast]")
    assert.ok(notification.textContent.includes(messages.folderAlreadyAdded))
    assert.ok(notification.classList.contains("cn-toast"))
    const toaster = container.querySelector("[data-sonner-toaster]")
    assert.equal(toaster.dataset.yPosition, "top")
    assert.equal(toaster.dataset.xPosition, "center")
    assert.notEqual(notification.dataset.richColors, "true")
    assert.deepEqual(calls.creates, [])
  })

  test(`${locale}: ordinary files display the folder-required message without an API call`, async t => {
    const { calls, container, messages } = await render(t, { locale, folder: null })
    await drag(container, "drop", ["notes.txt"])
    assert.ok(container.textContent.includes(messages.folderRequired))
    assert.deepEqual(calls, { paths: ["notes.txt"], lists: 0, creates: [], view: null })
  })

  test(`${locale}: multiple folders or mixed files are rejected together before resolving any path`, async t => {
    const { calls, container, messages } = await render(t, { locale })
    for (const names of [["project", "second-project"], ["project", "notes.txt"]]) {
      await drag(container, "drop", names)
      assert.ok(container.textContent.includes(messages.singleFolderRequired))
    }
    assert.deepEqual(calls, { paths: [], lists: 0, creates: [], view: null })
  })
}

test("a single folder creates a manual project and switches to the project list", async t => {
  const { calls, container, messages } = await render(t)
  await drag(container, "drop")
  assert.deepEqual(calls.creates, [{ name: "project", connectorId: "local", workspacePath: "/work/project", manuallyCreated: true }])
  assert.equal(calls.view, false)
  assert.ok(container.textContent.includes(messages.folderAdded))
})

test("an offline local device displays guidance without listing or creating projects", async t => {
  const { calls, container, messages } = await render(t, { online: false })
  await drag(container, "drop")
  assert.equal(calls.lists, 0)
  assert.deepEqual(calls.creates, [])
  assert.ok(container.textContent.includes(messages.localDeviceRequired))
})

test("the drop cue sits outside scrollable content and disappears after a drop", async t => {
  const { container, messages } = await render(t)
  const event = await drag(container, "dragover", ["project"], ["Files"], [{ isDirectory: true }])
  assert.equal(event.defaultPrevented, true)
  const cue = [...container.querySelectorAll("span")].find(node => node.textContent === messages.dropFolder)
  assert.ok(cue)
  assert.equal(cue.closest('[data-slot="sidebar-content"]'), null)
  await drag(container, "drop")
  assert.equal(container.textContent.includes(messages.dropFolder), false)
})

test("Web ignores file drops and desktop ignores non-file drags", async t => {
  const { calls, container, messages } = await render(t, { desktop: false })
  assert.equal((await drag(container, "dragover")).defaultPrevented, false)
  assert.equal((await drag(container, "drop")).defaultPrevented, false)
  assert.equal(container.textContent.includes(messages.dropFolder), false)
  window.desktopWorkbench = { files: { droppedFolderPath: () => assert.fail("not a file drag") } }
  assert.equal((await drag(container, "drop", [], ["text/plain"])).defaultPrevented, false)
  assert.deepEqual(calls.creates, [])
})
