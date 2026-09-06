import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = ts.transpileModule(
  readFileSync(new URL("../src/lib/clipboard.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

function load(globals = {}) {
  const context = vm.createContext({ exports: {}, ...globals })
  vm.runInContext(source, context)
  return context.exports.copyText
}

function documentFixture(copy = () => true) {
  const children = []
  const calls = []
  const range = { cloneRange: () => range }
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: () => calls.push("clear-selection"),
    addRange: (value) => { assert.equal(value, range); calls.push("restore-selection") },
  }
  const previousFocus = { isConnected: true, focus: () => calls.push("restore-focus"), closest: () => null }
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
    setSelectionRange: (start, end) => calls.push([start, end]),
    remove: () => children.splice(children.indexOf(textarea), 1),
  }
  const document = {
    activeElement: previousFocus,
    body: { appendChild: (element) => children.push(element) },
    getSelection: () => selection,
    createElement: (tag) => { assert.equal(tag, "textarea"); return textarea },
    execCommand: (command) => { assert.equal(command, "copy"); calls.push("copy"); return copy() },
  }
  return { document, calls, children, textarea }
}

test("modern clipboard copies the complete text without requiring a DOM", async () => {
  const writes = []
  const copyText = load({ navigator: { clipboard: { writeText: async (value) => writes.push(value) } } })
  await copyText("first line\nsecond line")
  assert.deepEqual(writes, ["first line\nsecond line"])
})

test("missing clipboard API uses a temporary selection inside the supplied dialog", async () => {
  const fixture = documentFixture()
  const container = { ownerDocument: fixture.document, appendChild: (element) => fixture.children.push(element) }
  fixture.document.body.appendChild = () => assert.fail("selection must stay inside the modal")
  await load({ navigator: {}, document: fixture.document })("full command\nnext line", container)
  assert.equal(fixture.textarea.value, "full command\nnext line")
  assert.deepEqual(fixture.calls, ["focus", "select", [0, 22], "copy", "restore-focus", "clear-selection", "restore-selection"])
  assert.equal(fixture.children.length, 0)
})

test("a rejected modern clipboard write falls back to the browser copy command", async () => {
  const fixture = documentFixture()
  const navigator = { clipboard: { writeText: async () => { throw new Error("NotAllowedError") } } }
  await load({ navigator, document: fixture.document })("command")
  assert.ok(fixture.calls.includes("copy"))
  assert.equal(fixture.children.length, 0)
})

test("fallback stays inside the focused menu or dialog when no container is supplied", async () => {
  const fixture = documentFixture()
  const focusBoundary = { appendChild: (element) => fixture.children.push(element) }
  fixture.document.activeElement.closest = () => focusBoundary
  fixture.document.body.appendChild = () => assert.fail("selection must stay inside the focus boundary")
  await load({ navigator: {}, document: fixture.document })("shared link")
  assert.equal(fixture.textarea.value, "shared link")
  assert.ok(fixture.calls.includes("copy"))
  assert.equal(fixture.children.length, 0)
})

test("a browser that declines legacy copying reports failure and restores the page", async () => {
  const fixture = documentFixture(() => false)
  await assert.rejects(load({ document: fixture.document })("command"), /Copy failed/)
  assert.equal(fixture.children.length, 0)
  assert.ok(fixture.calls.includes("restore-focus"))
  assert.ok(fixture.calls.includes("restore-selection"))
})

test("legacy exceptions still remove the temporary element and restore focus", async () => {
  const fixture = documentFixture(() => { throw new Error("copy blocked") })
  await assert.rejects(load({ document: fixture.document })("command"), /copy blocked/)
  assert.equal(fixture.children.length, 0)
  assert.ok(fixture.calls.includes("restore-focus"))
})

test("unsupported browsers do not report copying as successful", async () => {
  const fixture = documentFixture()
  delete fixture.document.execCommand
  await assert.rejects(load({ navigator: {}, document: fixture.document })("command"), /Clipboard is unavailable/)
  assert.equal(fixture.children.length, 0)
})

test("headless callers without either clipboard API receive a controlled error", async () => {
  await assert.rejects(load()("command"), /Clipboard is unavailable/)
})
