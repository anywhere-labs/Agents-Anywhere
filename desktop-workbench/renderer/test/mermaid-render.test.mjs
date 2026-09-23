import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import { JSDOM } from "jsdom"
import ts from "typescript"

const source = ts.transpileModule(readFileSync(new URL("../src/lib/mermaid-render.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText

function setup() {
  const { window } = new JSDOM()
  const calls = []
  let config
  const mermaid = {
    initialize(value) { config = value },
    async parse(code) { if (code === "incomplete") throw Error("syntax") },
    async render(id, code, container) {
      assert.ok(container.isConnected)
      const theme = config.theme
      await Promise.resolve()
      assert.equal(config.theme, theme)
      calls.push({ id, code, theme })
      if (code === "render-error") throw Error("layout")
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"></svg>' }
    },
  }
  const context = vm.createContext({ exports: {}, require: () => mermaid, document: window.document, DOMParser: window.DOMParser, XMLSerializer: window.XMLSerializer })
  vm.runInContext(source, context)
  return { render: context.exports.renderMermaid, calls, document: window.document, getConfig: () => config }
}

test("concurrent diagrams render serially with distinct IDs and requested themes", async () => {
  const fixture = setup()
  const images = await Promise.all([fixture.render("flowchart LR; A-->B", true), fixture.render("sequenceDiagram", false)])
  assert.deepEqual(fixture.calls.map(c => c.theme), ["dark", "default"])
  assert.notEqual(fixture.calls[0].id, fixture.calls[1].id)
  const svg = decodeURIComponent(images[0].split(",")[1])
  assert.match(svg, /width="800"/)
  assert.match(svg, /height="400"/)
  assert.equal(fixture.document.body.children.length, 0)
  assert.equal(fixture.getConfig().securityLevel, "strict")
})

test("invalid streaming source and render failures do not poison later diagrams or leak DOM", async () => {
  const fixture = setup()
  await assert.rejects(fixture.render("incomplete", false), /syntax/)
  await assert.rejects(fixture.render("render-error", false), /layout/)
  assert.equal(fixture.document.body.children.length, 0)
  assert.match(await fixture.render("valid", false), /^data:image\/svg\+xml/)
  assert.equal(fixture.document.body.children.length, 0)
})
