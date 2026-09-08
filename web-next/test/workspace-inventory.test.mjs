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
window.HTMLElement.prototype.scrollIntoView = function () {}
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
  if (url.endsWith('/components/auth/auth-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAuth = () => globalThis.inventoryAuth' }
  if (url.endsWith('/components/agent-setup-provider.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAgentSetupPairing = () => ({ requestAgentSetup() {}, waitForConnector() {}, readyConnectorIds: [] })' }
  return nextLoad(url, context)
} })
const { WorkspaceProvider, useWorkspace } = await import('../src/components/workspace-context.tsx')
const { AppSidebar } = await import('../src/components/app-sidebar.tsx')
const { SidebarProvider } = await import('../src/components/ui/sidebar.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
const { ArchivedSessionsTab } = await import('../src/components/settings/archived-sessions-tab.tsx')
authHooks.deregister(); hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const time = '2026-09-08T10:00:00Z'
const connector = { id: 'conn', userId: 'user', name: 'Device', status: 'online' }
const project = (id = 'p1', name = 'Project One') => ({ id, name, connectorId: 'conn', workspacePath: `/${id}`, manuallyCreated: true, pinned: false, createdAt: time, updatedAt: time, lastActivityAt: time, activeSessionCount: 0, sidebarSessionCounts: { active: 0, archived: 0 } })
const session = (id = 's1', projectId = 'p1', extra = {}) => ({ id, projectId, connectorId: 'conn', connectorStatus: 'online', runtime: 'dsh', runtimeType: 'dsh', runtimeId: 'rti', runtimeName: 'DSH', title: `Session ${id}`, cwd: `/${projectId}`, status: 'idle', archived: false, pinned: false, unread: false, lastReadSeq: 1, latestTurnEndSeq: 1, updatedSeq: 1, sortAt: time, lastActivityAt: time, ...extra })
const snapshot = (projects = [project()], sessions = [session()]) => ({ type: 'dashboard.snapshot', projects, sessions, connectors: [connector], serverTime: time, sessionPages: { active: { hasMore: false, nextCursor: null }, archived: { hasMore: false, nextCursor: null } } })
async function render(t, { sidebar = false, archives = false } = {}) {
  window.localStorage.clear(); window.sessionStorage.clear()
  globalThis.inventoryAuth = { session: { userId: 'user', accessToken: 'fixture-token' }, me: { displayName: 'User', role: 'admin' }, signOut() {} }
  Socket.instances = []
  const calls = { projects: 0, inventory: 0, connectors: 0, pages: 0 }
  t.mock.method(dashboardApi, 'createDashboardWsTicket', async () => ({ ticket: 'fixture-ticket' }))
  t.mock.method(dashboardApi, 'listProjects', async () => { calls.projects++; return { projects: [project()] } })
  t.mock.method(dashboardApi, 'listSessionInventory', async () => { calls.inventory++; return { sessions: [session()], serverTime: time } })
  t.mock.method(dashboardApi, 'listConnectors', async () => { calls.connectors++; return { connectors: [connector] } })
  for (const name of ['listProjectSessions', 'listSessions']) t.mock.method(dashboardApi, name, async () => { calls.pages++; throw new Error('Per-project and paginated reads must not run') })
  let state
  function Probe() {
    state = useWorkspace()
    return archives ? h(ArchivedSessionsTab, { token: 'fixture-token', projects: state.projects, sessions: state.sessions, loading: state.isLoading, onOpenSession() {}, onSessionUpdated: state.upsertSession, onWorkspaceRefresh: state.refreshData }) : null
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(WorkspaceProvider, null, h(Probe), sidebar ? h(SidebarProvider, null, h(AppSidebar)) : null))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { calls, container, get state() { return state }, async emit(value) { await act(async () => { Socket.instances.at(-1).emit(value); await delay(30) }) } }
}
function projectButton(container, name) {
  const button = [...container.querySelectorAll('button[aria-expanded]')].find(button => button.textContent.includes(name))
  assert.ok(button, `Missing project ${name}`)
  return button
}
test('a complete snapshot supplies every project without requests on expand and reopen', async (t) => {
  const view = await render(t, { sidebar: true })
  const rows = Array.from({ length: 105 }, (_, i) => session(`old-${i}`))
  await view.emit(snapshot([project(), project('p2', 'Project Two')], [...rows, session('other', 'p2')]))
  for (const name of ['Project One', 'Project Two', 'Project One', 'Project One']) await act(async () => projectButton(view.container, name).click())
  assert.equal(view.state.sessions.length, 106)
  assert.match(view.container.textContent, /Session old-104/)
  assert.match(view.container.textContent, /Session other/)
  assert.deepEqual(view.calls, { projects: 0, inventory: 0, connectors: 0, pages: 0 })
})
test('concurrent refreshes share one session inventory and one project request', async (t) => {
  const view = await render(t)
  await act(async () => { await Promise.all([view.state.refreshData(), view.state.refreshData()]) })
  assert.deepEqual(view.calls, { projects: 1, inventory: 1, connectors: 1, pages: 0 })
  assert.deepEqual(view.state.sessions.map(row => row.id), ['s1'])
})
test('unknown project sessions share a refresh and appear in the project when it arrives', async (t) => {
  const view = await render(t, { sidebar: true }); await view.emit(snapshot())
  let finish
  t.mock.method(dashboardApi, 'listProjects', () => { view.calls.projects++; return new Promise(resolve => { finish = resolve }) })
  await act(async () => { view.state.upsertSession(session('new-a', 'p2')); view.state.upsertSession(session('new-b', 'p2')) })
  assert.equal(view.calls.projects, 1)
  assert.match(view.container.textContent, /未分组会话/)
  await act(async () => finish({ projects: [project(), project('p2', 'Project Two')] }))
  await act(async () => projectButton(view.container, 'Project Two').click())
  assert.match(view.container.textContent, /Session new-a/)
  assert.match(view.container.textContent, /Session new-b/)
  assert.doesNotMatch(view.container.textContent, /未分组会话/)
  assert.equal(view.calls.inventory, 0)
})
test('unassigned sessions do not refetch projects on every message', async (t) => {
  const view = await render(t); await view.emit(snapshot())
  await act(async () => { view.state.upsertSession(session('orphan', null)) })
  assert.equal(view.calls.projects, 1)
  await act(async () => { view.state.upsertSession(session('orphan', null, { title: 'updated', updatedSeq: 2 })) })
  assert.equal(view.calls.projects, 1)
  assert.equal(view.calls.inventory, 0)
})
test('project edits refresh only projects; late reads cannot replace a newer push', async (t) => {
  const view = await render(t); await view.emit(snapshot())
  let finish
  t.mock.method(dashboardApi, 'updateProject', async () => ({ project: project('p1', 'Edited') }))
  t.mock.method(dashboardApi, 'listProjects', () => { view.calls.projects++; return new Promise(resolve => { finish = resolve }) })
  await act(async () => { await view.state.updateProject('p1', { name: 'Edited' }) })
  await view.emit(snapshot([project('p1', 'Newer push')]))
  await act(async () => finish({ projects: [project('p1', 'Old response')] }))
  assert.equal(view.state.projects[0].name, 'Newer push')
  assert.equal(view.calls.projects, 1)
  assert.equal(view.calls.inventory, 0)
})
test('a failed project refresh can retry after a later session update', async (t) => {
  const view = await render(t); await view.emit(snapshot())
  t.mock.method(dashboardApi, 'listProjects', async () => {
    view.calls.projects++
    if (view.calls.projects === 1) throw new Error('Temporary failure')
    return { projects: [project(), project('p2', 'Project Two')] }
  })
  await act(async () => { view.state.upsertSession(session('new', 'p2')) })
  assert.equal(view.state.sessions.length, 2)
  await act(async () => { view.state.upsertSession(session('new', 'p2', { updatedSeq: 2 })) })
  assert.equal(view.calls.projects, 2)
  assert.equal(view.state.projects.length, 2)
})
test('fresh inventories remove deleted rows and apply project and archive changes locally', async (t) => {
  const view = await render(t); const projects = [project(), project('p2', 'Project Two')]
  await view.emit(snapshot(projects, [session(), session('deleted')]))
  await view.emit(snapshot(projects, [session('s1', 'p2', { archived: true, updatedSeq: 3 })]))
  assert.equal(view.state.sessions.length, 1)
  assert.equal(view.state.sessions[0].projectId, 'p2')
  assert.equal(view.state.sessions[0].archived, true)
  assert.equal(view.calls.pages, 0)
})
test('archived settings read the shared inventory without a separate list request', async (t) => {
  const view = await render(t, { archives: true })
  await view.emit(snapshot([project()], [session(), session('archived', 'p1', { archived: true, archivedAt: time })]))
  assert.match(view.container.textContent, /Session archived/)
  assert.doesNotMatch(view.container.textContent, /Session s1/)
  assert.equal(view.calls.pages, 0)
  assert.equal(view.calls.inventory, 0)
})
test('a late full inventory cannot undo a completed project edit', async (t) => {
  const view = await render(t); await view.emit(snapshot())
  let finish
  t.mock.method(dashboardApi, 'listSessionInventory', () => new Promise(resolve => { finish = resolve }))
  t.mock.method(dashboardApi, 'updateProject', async () => ({ project: project('p1', 'Edited') }))
  await act(async () => { view.state.refreshData() })
  t.mock.method(dashboardApi, 'listProjects', async () => ({ projects: [project('p1', 'Edited')] }))
  await act(async () => { await view.state.updateProject('p1', { name: 'Edited' }) })
  await act(async () => finish({ sessions: [session()], serverTime: time }))
  assert.equal(view.state.projects[0].name, 'Edited')
  assert.equal(view.state.isLoading, false)
})
