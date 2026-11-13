import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test" })
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.qaTranslate = key => key

const sourceHooks = registerSource()
const mockHooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl") return { url: "data:text/javascript,export const useTranslations=()=>globalThis.qaTranslate", shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    return url.endsWith("/src/lib/api/index.ts")
      ? { format: "module", shortCircuit: true, source: "export const apiClient={get:path=>globalThis.qaGoalGet(path)}; export const isApiError=()=>false" }
      : next(url, context)
  },
})
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { useSessionGoal } = await import("../src/features/goals/use-session-goal.ts")

function Probe({ sessionId, enabled }) {
  globalThis.qaGoal = useSessionGoal("token", sessionId, false, enabled)
  return null
}

const goalState = sessionId => ({ sessionId, runtime: "dsh", freshness: "unknown", revision: 0, capabilities: { supported: false, actions: [] } })

function mount(t) {
  const host = document.createElement("div")
  const root = createRoot(host)
  t.after(async () => { await act(async () => { root.unmount() }) })
  return async props => { await act(async () => { root.render(h(Probe, props)); await delay(20) }) }
}

test("a session still being created reads no goal state until it has its Server ID", async t => {
  const requests = []
  globalThis.qaGoalGet = async path => {
    requests.push(path)
    if (path !== "/sessions/session_server/goal") throw new Error("session not found")
    return goalState("session_server")
  }
  const render = mount(t)
  await render({ sessionId: "session_local", enabled: false })
  assert.deepEqual(requests, [])
  assert.equal(globalThis.qaGoal.error, null)

  await render({ sessionId: "session_server", enabled: true })
  assert.deepEqual(requests, ["/sessions/session_server/goal"])
  assert.equal(globalThis.qaGoal.error, null)
  assert.equal(globalThis.qaGoal.state?.sessionId, "session_server")
})

test("a failed goal read of a created session is still reported", async t => {
  globalThis.qaGoalGet = async () => { throw new Error("unavailable") }
  const render = mount(t)
  await render({ sessionId: "session_server", enabled: true })
  assert.equal(globalThis.qaGoal.error, "stateUnavailable")
})

test.after(() => { mockHooks.deregister(); sourceHooks.deregister(); dom.window.close() })
