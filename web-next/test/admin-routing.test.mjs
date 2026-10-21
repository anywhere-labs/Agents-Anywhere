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
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
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
const hooks = registerSource()
const authHooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/components/auth/auth-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAuth = () => globalThis.routingAuth' }
  if (url.endsWith('/components/agent-setup-provider.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAgentSetupPairing = () => ({ requestAgentSetup() {}, waitForConnector() {}, readyConnectorIds: [] })' }
  if (url.endsWith('/features/desktop/desktop-connector-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDesktopConnector = () => ({ isLocalConnector: () => false })' }
  if (url.endsWith('/components/device-pairing-provider.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDevicePairing = () => ({ waitForConnector() {}, clearPairing() {}, readyConnectorIds: [] })' }
  return nextLoad(url, context)
} })
const { WorkspaceProvider, useWorkspace } = await import('../src/components/workspace-context.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
authHooks.deregister(); hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const time = '2026-09-08T10:00:00Z'
const connector = { id: 'conn', userId: 'user', name: 'Device', status: 'online' }
const project = { id: 'p1', name: 'Project One', connectorId: 'conn', workspacePath: '/p1', manuallyCreated: true, pinned: false, createdAt: time, updatedAt: time, lastActivityAt: time, activeSessionCount: 0, sessionCount: 1 }
const session = { id: 's1', projectId: 'p1', connectorId: 'conn', connectorStatus: 'online', runtime: 'dsh', runtimeType: 'dsh', runtimeId: 'rti', runtimeName: 'DSH', title: 'Session s1', cwd: '/p1', status: 'idle', archived: false, pinned: false, unread: false, lastReadSeq: 0, updatedSeq: 1, seq: 1, createdAt: time, updatedAt: time, sortAt: time, lastActivityAt: time, origin: 'connector_import' }
const snapshot = { type: 'dashboard.snapshot', projects: [project], sessions: [session], connectors: [connector], serverTime: time, sessionPages: { active: { hasMore: false, nextCursor: null }, archived: { hasMore: false, nextCursor: null } } }

async function render(t, hash, role = 'admin') {
  window.localStorage.clear(); window.sessionStorage.clear()
  window.history.replaceState({}, '', '/' + hash)
  globalThis.routingAuth = { session: { userId: 'user', accessToken: 'fixture-token' }, me: { displayName: 'User', role }, signOut() {} }
  Socket.instances = []
  const calls = { tickets: 0, projects: 0, inventory: 0, connectors: 0 }
  t.mock.method(dashboardApi, 'createDashboardWsTicket', async () => { calls.tickets++; return { ticket: 'fixture-ticket' } })
  t.mock.method(dashboardApi, 'listProjects', async () => { calls.projects++; return { projects: [project] } })
  t.mock.method(dashboardApi, 'listSessionInventory', async () => { calls.inventory++; return { sessions: [session], serverTime: time } })
  t.mock.method(dashboardApi, 'listConnectors', async () => { calls.connectors++; return { connectors: [connector] } })
  let state
  function Probe() { state = useWorkspace(); return null }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const settle = async () => { await act(async () => { await delay(40) }) }
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(WorkspaceProvider, null, h(Probe)))))
  await settle()
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return {
    calls,
    get state() { return state },
    settle,
    async emit(value) { await act(async () => { Socket.instances.at(-1).emit(value); await delay(30) }) },
  }
}

test('legacy administration routes open the matching section without loading the workspace', async (t) => {
  for (const [hash, section] of [['#/dashboard', 'overview'], ['#/team', 'team'], ['#/service', 'service-general']]) {
    const view = await render(t, hash)
    assert.equal(view.state.page, 'admin', hash)
    assert.equal(view.state.adminSection, section, hash)
    assert.equal(Socket.instances.length, 0, `${hash} must not open the dashboard socket`)
    assert.deepEqual(view.calls, { tickets: 0, projects: 0, inventory: 0, connectors: 0 }, hash)
  }
})

test('unknown sections fall back to the overview and navigation rewrites the hash', async (t) => {
  const view = await render(t, '#/admin/records')
  assert.equal(view.state.adminSection, 'overview')
  await act(async () => view.state.navigate('admin', 'announcements'))
  assert.equal(window.location.hash, '#/admin/announcements')
  assert.equal(view.state.adminSection, 'announcements')
  await act(async () => view.state.navigate('admin'))
  assert.equal(window.location.hash, '#/admin/overview')
  await act(async () => view.state.navigate('settings', 'appearance'))
  assert.equal(window.location.hash, '#/settings/appearance')
  assert.equal(view.state.settingsTab, 'appearance')
  assert.equal(view.state.adminSection, 'overview')
})

test('returning home from administration resumes the dashboard socket and applies its snapshot', async (t) => {
  const view = await render(t, '#/admin/usage')
  assert.equal(Socket.instances.length, 0)
  await act(async () => view.state.goHome())
  await view.settle()
  assert.equal(view.state.page, 'home')
  assert.equal(Socket.instances.length, 1)
  assert.equal(view.calls.tickets, 1)
  await view.emit(snapshot)
  assert.equal(view.state.isLoading, false)
  assert.deepEqual(view.state.sessions.map((item) => item.id), ['s1'])
  assert.deepEqual(view.state.projects.map((item) => item.id), ['p1'])
})

test('personal settings skip the workspace except for archived sessions', async (t) => {
  const view = await render(t, '#/settings/account')
  assert.equal(view.state.page, 'settings')
  assert.equal(Socket.instances.length, 0)
  assert.equal(view.calls.tickets, 0)
  await act(async () => view.state.navigate('settings', 'archived-sessions'))
  await view.settle()
  assert.equal(Socket.instances.length, 1, 'archived sessions need the shared inventory')
  await view.emit(snapshot)
  assert.deepEqual(view.state.sessions.map((item) => item.id), ['s1'])
})

test('the home page keeps loading the workspace as before', async (t) => {
  const view = await render(t, '#/')
  assert.equal(view.state.page, 'home')
  assert.equal(Socket.instances.length, 1)
  await view.emit(snapshot)
  assert.equal(view.state.isLoading, false)
})
