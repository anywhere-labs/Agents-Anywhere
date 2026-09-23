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
const source = ts.transpileModule(readFileSync(new URL("../src/components/mermaid-preview.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText

test("streaming changes retain the last valid diagram and ignore stale results", async () => {
  const { window } = new JSDOM('<div id="root"></div>')
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const pending = []
  const timers = new Map()
  let timerId = 0
  const stubs = {
    "next-themes": { useTheme: () => ({ resolvedTheme: "dark" }) },
    "next-intl": { useTranslations: () => key => key },
    "@/lib/mermaid-render": { renderMermaid: code => new Promise((resolve, reject) => pending.push({ code, resolve, reject })) },
  }
  const context = vm.createContext({ exports: {}, require: name => stubs[name] ?? require(name), setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) })
  vm.runInContext(source, context)
  const root = createRoot(window.document.getElementById("root"))
  const render = async code => act(() => root.render(React.createElement(context.exports.MermaidPreview, { code }, React.createElement("pre", null, code))))
  const flush = () => { for (const fn of timers.values()) fn(); timers.clear() }
  try {
    await render("old")
    assert.equal(window.document.querySelector("pre").textContent, "old")
    flush()
    await render("new")
    flush()
    await act(async () => { pending[0].resolve("data:image/svg+xml,old") })
    assert.equal(window.document.querySelector("img"), null)
    await act(async () => { pending[1].resolve("data:image/svg+xml,new") })
    assert.match(window.document.querySelector("img").src, /new$/)
    assert.equal(window.document.querySelector("details pre").textContent, "new")
    const image = window.document.querySelector("img")
    await render("invalid")
    assert.equal(window.document.querySelector("img"), image)
    assert.match(image.src, /new$/)
    flush()
    await act(async () => { pending[2].reject(Error("syntax")) })
    assert.equal(window.document.querySelector("img"), image)
    assert.equal(window.document.querySelector("details pre").textContent, "invalid")
    assert.equal(window.document.querySelector('[role="status"]').textContent, "mermaidUpdateFailed")
    await render("recovered")
    flush()
    assert.equal(window.document.querySelector("img"), image)
    await act(async () => { pending[3].resolve("data:image/svg+xml,recovered") })
    assert.equal(window.document.querySelector("img"), image)
    assert.match(image.src, /recovered$/)
    assert.equal(window.document.querySelector('[role="status"]'), null)
    await render("cancelled")
    await act(() => root.unmount())
    assert.equal(timers.size, 0)
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    window.close()
  }
})
