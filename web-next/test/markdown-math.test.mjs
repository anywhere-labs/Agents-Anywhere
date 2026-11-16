import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import vm from "node:vm"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import ts from "typescript"
import { remarkStandaloneDisplayMath } from "../src/lib/markdown-math.ts"
import * as sessionFileLink from "../src/lib/session-file-link.ts"

const require = createRequire(import.meta.url)
const passthrough = ({ children }) => React.createElement("div", null, children)
const stubs = {
  "@/components/mermaid-preview": { MermaidPreview: ({ code, children }) => React.createElement("div", { "data-mermaid-source": code }, children) },
  "@/lib/markdown-math": { remarkStandaloneDisplayMath },
  "@/lib/clipboard": { copyText() {} },
  "@/lib/utils": { cn: (...args) => args.filter(Boolean).join(" ") },
  "@/components/source-code-block": {
    SourceCodeBlock: passthrough,
    SourceCodeContent: ({ code }) => React.createElement("pre", null, code),
  },
  "@/lib/file-preview-window": { openNativeFilePreviewWindow() {} },
  "@/lib/session-file-link": sessionFileLink,
  "@/components/ui/badge": { Badge: passthrough },
  "@/components/ui/scroll-area": { ScrollArea: passthrough, ScrollBar: () => null },
  "@/components/ui/dialog": {
    Dialog: ({ open, children }) => open ? children : null,
    DialogContent: passthrough,
    DialogTitle: passthrough,
  },
  "@/components/session/session-file-preview-context": { useSessionFilePreviewOpener: () => null },
  "next-intl": { useTranslations: () => key => key },
}
const source = ts.transpileModule(readFileSync(new URL("../src/components/markdown-text.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText
const context = vm.createContext({ exports: {}, require: name => stubs[name] ?? require(name) })
// The component lives inside the vm, so its `document`/`window` references
// resolve to the vm global. Bridge them to the real globals (swapped by the
// streaming/click tests) so browser-only APIs work when handlers run.
Object.defineProperty(context, "document", { get: () => globalThis.document })
Object.defineProperty(context, "window", { get: () => globalThis.window })
vm.runInContext(source, context)
function render(text) {
  return new JSDOM(renderToStaticMarkup(React.createElement(context.exports.MarkdownText, { text }))).window.document
}

test("renders Fourier equations as display math, including same-line dollar delimiters", () => {
  const formula = String.raw`F(\omega)=\int_{-\infty}^{\infty} f(t)e^{-i\omega t}\,dt`
  for (const text of [`$$${formula}$$`, `$$\n${formula}\n$$`]) {
    const doc = render(text)
    assert.equal(doc.querySelectorAll(".katex-display").length, 1)
    assert.equal(doc.querySelector("annotation").textContent, formula)
    assert.equal(doc.querySelector(".katex-error"), null)
    assert.equal(doc.querySelector("pre"), null)
  }
})

test("inline math stays inline inside Chinese prose", () => {
  const doc = render(String.raw`以频率 $f$ 表示（$\omega = 2\pi f$）。`)
  assert.equal(doc.querySelectorAll(".katex").length, 2)
  assert.equal(doc.querySelector(".katex-display"), null)
  assert.match(doc.body.textContent, /以频率/)
})

test("code and escaped dollars remain literal", () => {
  const doc = render('`$x$`\n\n```text\n$$x^2$$\n```\n\n价格 \\$5')
  assert.equal(doc.querySelector(".katex"), null)
  assert.match(doc.querySelector("pre").textContent, /\$\$x\^2\$\$/)
  assert.match(doc.body.textContent, /价格 \$5/)
})

test("incomplete streaming math and invalid LaTeX do not crash the reply", () => {
  assert.match(render('before $x^').body.textContent, /before \$x\^/)
  assert.match(render(String.raw`before $\frac{$ after`).body.textContent, /after/)
})

test("GFM tables and normal highlighted code blocks remain available", () => {
  const doc = render('| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst n = 1\n```')
  assert.equal(doc.querySelectorAll("td").length, 2)
  assert.match(doc.querySelector("pre").textContent, /const n = 1/)
})

test("in-page anchors stay in-page (no target=_blank)", () => {
  const doc = render('[跳到段落](#section-1)')
  const anchor = doc.querySelector('a[href="#section-1"]')
  assert.ok(anchor, "anchor link should render")
  assert.equal(anchor.getAttribute("target"), null)
  assert.equal(anchor.getAttribute("rel"), null)
})


test("Mermaid fences route to the diagram renderer while preserving source", () => {
  const doc = render('```mermaid\ngraph LR; A-->B\n```\n\n```text\ngraph LR; A-->B\n```')
  assert.equal(doc.querySelectorAll("[data-mermaid-source]").length, 1)
  assert.equal(doc.querySelector("[data-mermaid-source]").getAttribute("data-mermaid-source"), "graph LR; A-->B")
  assert.equal(doc.querySelectorAll("pre").length, 2)
})


test("streaming Markdown preserves the mounted Mermaid subtree", async () => {
  const { window } = new JSDOM('<div id="root"></div>')
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(window.document.getElementById("root"))
  const renderMessage = async text => act(() => root.render(React.createElement(context.exports.MarkdownText, { text })))
  try {
    await renderMessage('```mermaid\ngraph LR; A-->B\n```')
    const diagram = window.document.querySelector('[data-mermaid-source]')
    assert.ok(diagram)
    await renderMessage('```mermaid\ngraph LR; A-->B\n```\n\n继续回复')
    assert.equal(window.document.querySelector('[data-mermaid-source]'), diagram)
    await renderMessage('```mermaid\ngraph LR; A-->B; B-->C\n```\n\n继续回复')
    assert.equal(window.document.querySelector('[data-mermaid-source]'), diagram)
    assert.equal(diagram.getAttribute('data-mermaid-source'), 'graph LR; A-->B; B-->C')
  } finally {
    await act(() => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    window.close()
  }
})

test("clicking an in-page anchor scrolls without changing location.hash", async () => {
  const { window } = new JSDOM('<div id="root"></div><div id="target">target</div>')
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.location.hash = "#/session/s1"

  let scrolledTo = null
  window.document.getElementById("target").scrollIntoView = () => { scrolledTo = "target" }

  const root = createRoot(window.document.getElementById("root"))
  try {
    await act(() => root.render(React.createElement(context.exports.MarkdownText, { text: '[跳](#target)' })))
    const anchor = window.document.querySelector('#root a[href="#target"]')
    assert.ok(anchor, "anchor renders")
    anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
    assert.equal(scrolledTo, "target")
    assert.equal(window.location.hash, "#/session/s1", "location.hash must not be overwritten")
  } finally {
    await act(() => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    window.close()
  }
})
