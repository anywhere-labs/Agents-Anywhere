import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import * as React from "react"
import { createRoot } from "react-dom/client"
import ts from "typescript"
import { registerSource } from "./helpers/onboarding-source.mjs"

const hooks = registerSource()
const { selectPinnedSessions } = await import("../src/components/sidebar/sidebar-selectors.ts")
hooks.deregister()

// Exercise AppSidebar's actual memo with React retaining it across filter changes.
const sidebar = readFileSync(new URL("../src/components/app-sidebar.tsx", import.meta.url), "utf8")
const start = sidebar.indexOf("  const pinnedSessions = React.useMemo(")
const end = sidebar.indexOf("\n  const regularProjects =", start)
const memo = ts.transpileModule(sidebar.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const Probe = new Function("React", "selectPinnedSessions", `
  return function Probe(props) {
    const { sessions, filter } = props
    ${memo}
    return React.createElement("output", null, pinnedSessions.map(item => item.id).join(","))
  }
`)(React, selectPinnedSessions)

test("the pinned sidebar responds to device and Agent changes when the session inventory stays unchanged", async t => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>")
  for (const name of ["window", "document", "navigator"]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  t.after(async () => {
    await React.act(async () => root.unmount())
    dom.window.close()
  })
  const sessions = [
    { id: "a-codex", connectorId: "conn-a", runtime: "codex", pinned: true, archived: false },
    { id: "a-claude", connectorId: "conn-a", runtime: "claude", pinned: true, archived: false },
    { id: "b-codex", connectorId: "conn-b", runtime: "codex", pinned: true, archived: false },
  ]
  for (const [filter, expectedIds] of [
    [{ connectorId: "all", runtime: "all" }, "a-codex,a-claude,b-codex"],
    [{ connectorId: "conn-a", runtime: "codex" }, "a-codex"],
    [{ connectorId: "all", runtime: "codex" }, "a-codex,b-codex"],
    [{ connectorId: "conn-b", runtime: "all" }, "b-codex"],
  ]) {
    await React.act(async () => root.render(React.createElement(Probe, { sessions, filter })))
    assert.equal(container.textContent, expectedIds)
  }
})
