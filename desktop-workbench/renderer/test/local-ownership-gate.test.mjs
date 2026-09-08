import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/features/desktop/local-ownership-gate.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("gate.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "LocalOwnershipGate")
const code = ts.transpileModule(component.getText(ast).replace("export ", ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText

function fixture(initial, api) {
  let state = initial, busy = false, index = 0, effect, cleanup
  const elements = []
  const globals = {
    React: { createElement: (type, props, ...children) => { const element = { type, props, children }; elements.push(element); return element } },
    useState: () => index++ === 0 ? [state, value => { state = value }] : [busy, value => { busy = value }],
    useEffect: callback => { effect = callback },
    useTranslations: () => key => key,
    getDesktopWorkbenchBridge: () => api ? { ownership: api } : null,
  }
  for (const name of ["AlertDialog", "AlertDialogContent", "AlertDialogDescription", "AlertDialogFooter", "AlertDialogHeader", "AlertDialogTitle", "Button", "LoadingState"]) globals[name] = name
  const Gate = vm.runInNewContext(`${code}\nLocalOwnershipGate`, globals)
  return {
    render() { index = 0; elements.length = 0; return Gate({ children: "AUTH-AND-PROVISIONING" }) },
    mount() { cleanup = effect() }, unmount() { cleanup?.() }, elements,
    get state() { return state }, get busy() { return busy },
  }
}

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
