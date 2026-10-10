import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/features/desktop/local-ownership-gate.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("gate.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
// The component and its module helpers; the fixture supplies everything imported.
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)).map(node => node.getText(ast).replace(/^export /, ""))
const code = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText

function fixture(initial, api, { connector, copyText = async () => {} } = {}) {
  // useState slots in call order: state, busy, copied.
  const slots = [initial, false, false]
  let index = 0, effect, cleanup
  const elements = []
  const globals = {
    React: { createElement: (type, props, ...children) => { const element = { type, props, children }; elements.push(element); return element } },
    useState: () => { const slot = index++; return [slots[slot], value => { slots[slot] = value }] },
    useEffect: callback => { effect = callback },
    useTranslations: () => key => key,
    getDesktopWorkbenchBridge: () => api ? { ownership: api, connector } : null,
    copyText,
    // Errors thrown by the fixture's bridge come from this realm.
    Error,
  }
  for (const name of ["AlertDialog", "AlertDialogContent", "AlertDialogDescription", "AlertDialogFooter", "AlertDialogHeader", "AlertDialogTitle", "Button", "LoadingState", "Check", "Copy", "FolderOpen"]) globals[name] = name
  const Gate = vm.runInNewContext(`${code}\nLocalOwnershipGate`, globals)
  return {
    render() { index = 0; elements.length = 0; return Gate({ children: "AUTH-AND-PROVISIONING" }) },
    mount() { cleanup = effect() }, unmount() { cleanup?.() }, elements,
    get state() { return slots[0] }, get busy() { return slots[1] }, get copied() { return slots[2] },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const labels = h => h.elements.filter(e => e.type === "Button").map(b => b.children.at(-1))

test("conflict blocks auth, cannot dismiss, and only offers quit and atomic recheck", async () => {
  let checks = 0, quits = 0, succeed = false
  const h = fixture({ status: "conflict" }, {
    quit: async () => { quits++ },
    recheck: async () => { checks++; return { status: succeed ? "owned" : "conflict" } },
  })
  h.render()
  const buttons = h.elements.filter(e => e.type === "Button")
  assert.deepEqual(buttons.map(b => b.children[0]), ["quit", "recheck"])
  const dialog = h.elements.find(e => e.type === "AlertDialog")
  assert.equal(dialog.props.open, true)
  dialog.props.onOpenChange(false)
  assert.equal(h.state.status, "conflict")
  let prevented = false
  h.elements.find(e => e.type === "AlertDialogContent").props.onEscapeKeyDown({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  buttons[0].props.onClick()
  assert.equal(quits, 1)
  buttons[1].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(checks, 1)
  assert.equal(h.state.status, "conflict")
  succeed = true
  buttons[1].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.render(), "AUTH-AND-PROVISIONING")
})

test("a late startup snapshot cannot overwrite a newer ownership event", async () => {
  let resolve, notify, unsubscribed = false
  const h = fixture(null, {
    getState: () => new Promise(done => { resolve = done }),
    onState: listener => { notify = listener; return () => { unsubscribed = true } },
  })
  assert.equal(h.render().type, "LoadingState")
  h.mount()
  notify({ status: "conflict" })
  resolve({ status: "owned" })
  await new Promise(done => setImmediate(done))
  assert.equal(h.state.status, "conflict")
  h.unmount()
  assert.equal(unsubscribed, true)
})

test("first-run provisioning shows progress instead of the failure dialog", () => {
  let notify
  const h = fixture(null, {
    getState: () => new Promise(() => {}),
    onState: listener => { notify = listener; return () => {} },
  })
  h.render()
  h.mount()
  notify({ status: "preparing" })
  const loading = h.render()
  assert.equal(loading.type, "LoadingState")
  assert.equal(loading.props.label, "preparing")
  assert.equal(h.elements.some(e => e.type === "AlertDialog"), false)
  notify({ status: "owned" })
  assert.equal(h.render(), "AUTH-AND-PROVISIONING")
})

test("a failure quotes its error and offers copying it and opening the logs folder", async () => {
  const copies = [], opened = []
  const message = "Connector RPC exited with code 2\nLast output:\nerror: Failed to fetch: https://pypi.example/simple/"
  const h = fixture({ status: "error", message }, { quit: async () => {}, recheck: async () => ({ status: "owned" }) }, {
    connector: { openLogsFolder: async () => { opened.push(true); return "" } },
    copyText: async text => { copies.push(text) },
  })
  h.render()
  assert.deepEqual(h.elements.find(e => e.type === "AlertDialogDescription").children, ["errorDescription"])
  assert.deepEqual(h.elements.find(e => e.type === "pre").children, [message])
  assert.deepEqual(labels(h), ["copyError", "openLogs", "quit", "recheck"])
  const [copy, logs] = h.elements.filter(e => e.type === "Button")
  copy.props.onClick()
  await settle()
  assert.deepEqual(copies, [message])
  h.render()
  assert.equal(labels(h)[0], "copied")
  logs.props.onClick()
  assert.equal(opened.length, 1)
})

test("a failure without details still points to the logs folder", () => {
  const h = fixture({ status: "error" }, { quit: async () => {}, recheck: async () => ({ status: "error" }) }, {
    connector: { openLogsFolder: async () => "" },
  })
  h.render()
  assert.deepEqual(h.elements.find(e => e.type === "AlertDialogDescription").children, ["errorWithoutDetail"])
  assert.equal(h.elements.some(e => e.type === "pre"), false)
  assert.deepEqual(labels(h), ["openLogs", "quit", "recheck"])
})

test("checking shows progress until the first probe answers", async () => {
  const h = fixture(null, { getState: async () => ({ status: "checking" }), onState: () => () => {} })
  assert.equal(h.render().type, "LoadingState")
  h.mount()
  await settle()
  const loading = h.render()
  assert.equal(loading.type, "LoadingState")
  assert.equal(loading.props.label, "checkingConnector")
  assert.equal(h.elements.some(e => e.type === "AlertDialog"), false)
})

test("a failed bridge call is the error the dialog quotes", async () => {
  const h = fixture(null, {
    getState: async () => { throw new Error("Desktop backend is not ready.") },
    onState: () => () => {},
  })
  h.render()
  h.mount()
  await settle()
  assert.equal(h.state.status, "error")
  assert.equal(h.state.message, "Desktop backend is not ready.")
  h.render()
  assert.deepEqual(h.elements.find(e => e.type === "pre").children, ["Desktop backend is not ready."])
})
