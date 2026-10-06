import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.DocumentFragment = window.DocumentFragment
class Socket {
  static instances = []
  constructor() { Socket.instances.push(this) }
  close() {}
  emit(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
globalThis.WebSocket = Socket

const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')

const sourceHooks = registerSource()
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/components/auth/auth-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAuth = () => globalThis.inventoryAuth' }
  if (url.endsWith('/components/agent-setup-provider.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAgentSetupPairing = () => ({ requestAgentSetup() {}, waitForConnector() {}, readyConnectorIds: [] })' }
  if (url.endsWith('/features/desktop/desktop-connector-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDesktopConnector = () => ({ isLocalConnector: () => false })' }
  if (url.endsWith('/components/device-pairing-provider.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDevicePairing = () => ({ waitForConnector() {}, clearPairing() {}, readyConnectorIds: [] })' }
  if (url.endsWith('/features/desktop/bridge.ts')) return { format: 'module', shortCircuit: true, source: 'export const getDesktopWorkbenchBridge = () => globalThis.workbenchBridge\nexport const hasDesktopConnectorBridge = () => Boolean(globalThis.workbenchBridge)' }
  return nextLoad(url, context)
} })
const { WorkspaceProvider } = await import('../src/components/workspace-context.tsx')
const { DesktopSessionNotifications } = await import('../src/components/desktop/desktop-session-notifications.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
hooks.deregister()
sourceHooks.deregister()

const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const time = '2026-09-08T10:00:00Z'
const session = (id = 's1', extra = {}) => ({ id, connectorId: 'conn', connectorStatus: 'online', runtime: 'dsh', runtimeType: 'dsh', runtimeId: 'rti', runtimeName: 'DSH', title: `Session ${id}`, cwd: '/p1', status: 'idle', archived: false, pinned: false, unread: false, lastReadSeq: 1, latestTurnEndSeq: 1, updatedSeq: 1, sortAt: time, lastActivityAt: time, ...extra })
const snapshot = (sessions) => ({ type: 'dashboard.snapshot', projects: [], sessions, connectors: [], serverTime: time, sessionPages: { active: { hasMore: false, nextCursor: null }, archived: { hasMore: false, nextCursor: null } } })

async function render(t) {
  window.localStorage.clear(); window.sessionStorage.clear()
  globalThis.inventoryAuth = { session: { userId: 'user', accessToken: 'fixture-token' }, me: { displayName: 'User' }, signOut() {} }
  const shown = []
  let route = { page: 'home' }
  globalThis.workbenchBridge = {
    notifications: {
      show: async (input) => { shown.push(input); return { shown: true } },
      onClick() {},
    },
  }
  Socket.instances = []
  t.mock.method(dashboardApi, 'createDashboardWsTicket', async () => ({ ticket: 'fixture-ticket' }))
  let noticesResponse = { notices: [], serverTime: time }
  const probeCalls = []
  t.mock.method(dashboardApi, 'listSessionRuntimeNotices', async (token, sessionId) => {
    probeCalls.push({ token, sessionId })
    return noticesResponse
  })
  const { useWorkspace } = await import('../src/components/workspace-context.tsx')
  function RouteProbe() {
    const workspace = useWorkspace()
    route = workspace
    return null
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(
    h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' },
      h(WorkspaceProvider, null, h(DesktopSessionNotifications), h(RouteProbe))),
  ))
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete globalThis.workbenchBridge })
  return {
    shown,
    probeCalls,
    get route() { return route },
    setNotices(value) { noticesResponse = value },
    async emit(sessions) {
      await act(async () => { Socket.instances.at(-1).emit(snapshot(sessions)); await delay(30) })
    },
    async setOpenSession(id) {
      await act(async () => { route.openSession(id); await delay(30) })
    },
  }
}

test('an open input_request notice notifies with its own title and message', async (t) => {
  const view = await render(t)
  await view.emit([session('s1')])
  assert.deepEqual(view.probeCalls, [])
  view.setNotices({ notices: [{ noticeId: 'n1', type: 'interaction', sessionId: 's1', source: {}, title: '需要你的回答', message: '选一个选项', severity: 'info', status: 'open', interactionType: 'input_request', blocking: { scope: 'session', targetId: 's1' }, responseRequired: true, actions: [], context: {}, metadata: {}, revision: 1, updatedSeq: 2, createdAt: time, updatedAt: time }], serverTime: time })
  await view.emit([session('s1', { status: 'waiting_approval', updatedSeq: 2 })])
  await delay(20)
  assert.deepEqual(view.probeCalls, [{ token: 'fixture-token', sessionId: 's1' }])
  assert.deepEqual(view.shown, [{ title: '需要你的回答', body: '选一个选项', sessionId: 's1' }])
  // The notification is one-shot per waiting_approval episode; further effect
  // runs (e.g. unrelated session changes) must not notify or probe again.
  await view.emit([session('s1', { status: 'waiting_approval', updatedSeq: 3 }), session('s2')])
  await delay(20)
  assert.deepEqual(view.probeCalls, [{ token: 'fixture-token', sessionId: 's1' }])
  assert.deepEqual(view.shown.length, 1)
  // A later episode without any open interaction falls back to the generic one.
  view.setNotices({ notices: [], serverTime: time })
  await view.emit([session('s1', { status: 'running', updatedSeq: 4 })])
  await view.emit([session('s1', { status: 'waiting_approval', updatedSeq: 5 })])
  await delay(20)
  assert.deepEqual(view.shown, [
    { title: '需要你的回答', body: '选一个选项', sessionId: 's1' },
    { title: '会话等待你的确认', body: 'Session s1', sessionId: 's1' },
  ])
})

test('waiting_approval without a listing falls back to the generic approval notification', async (t) => {
  const view = await render(t)
  await view.emit([session('s1', { status: 'waiting_approval', updatedSeq: 2 })])
  await delay(20)
  assert.equal(view.probeCalls.length, 1)
  assert.deepEqual(view.shown, [{ title: '会话等待你的确认', body: 'Session s1', sessionId: 's1' }])
})

test('the open session page never notifies and probes are not repeated while waiting', async (t) => {
  const view = await render(t)
  await view.emit([session('s1', { status: 'idle' })])
  await view.setOpenSession('s1')
  await view.emit([session('s1', { status: 'waiting_approval', updatedSeq: 2 })])
  await delay(20)
  assert.deepEqual(view.probeCalls, [])
  assert.deepEqual(view.shown, [])
  // Back on home, the session is still waiting: first probe shows the fallback.
  await act(async () => { view.route.goHome(); await delay(30) })
  await delay(100)
  assert.equal(view.probeCalls.length, 1)
  assert.deepEqual(view.shown, [{ title: '会话等待你的确认', body: 'Session s1', sessionId: 's1' }])
})

test('running → stopping → idle notifies as interrupted instead of completed', async (t) => {
  const view = await render(t)
  await view.emit([session('s1', { status: 'running', unread: true, updatedSeq: 2 })])
  assert.deepEqual(view.shown, [])
  await view.emit([session('s1', { status: 'stopping', unread: true, updatedSeq: 3 })])
  await view.emit([session('s1', { status: 'idle', unread: true, latestTurnEndSeq: 2, updatedSeq: 4 })])
  await delay(20)
  assert.deepEqual(view.shown, [{ title: '任务已中断', body: 'Session s1', sessionId: 's1' }])
  // A later turn without stopping reports completion again.
  await view.emit([session('s1', { status: 'running', unread: false, updatedSeq: 5 })])
  await view.emit([session('s1', { status: 'idle', unread: true, latestTurnEndSeq: 3, updatedSeq: 6 })])
  await delay(20)
  assert.deepEqual(view.shown, [
    { title: '任务已中断', body: 'Session s1', sessionId: 's1' },
    { title: '会话已完成', body: 'Session s1', sessionId: 's1' },
  ])
})
