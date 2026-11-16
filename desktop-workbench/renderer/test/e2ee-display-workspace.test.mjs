// The workspace shows decrypted display envelopes in the sidebar and the session detail, the 「加密中」
// placeholder for sessions it cannot open, and assigns sessions the device found on its own to a project.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/#/session/ses_found', pretendToBeVisual: true })
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
  // Desktop-only hooks the sidebar uses; the fixture device is never the local Connector.
  if (url.endsWith('/features/desktop/desktop-connector-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDesktopConnector = () => ({ isLocalConnector: () => false })' }
  if (url.endsWith('/components/device-pairing-provider.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDevicePairing = () => ({ waitForConnector() {}, clearPairing() {}, readyConnectorIds: [] })' }
  return nextLoad(url, context)
} })
const { WorkspaceProvider, useWorkspace } = await import('../src/components/workspace-context.tsx')
const { AppSidebar } = await import('../src/components/app-sidebar.tsx')
const { SidebarProvider } = await import('../src/components/ui/sidebar.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
const { startE2ee } = await import('../src/features/e2ee/runtime.ts')
const { displayEnvelopeAd, sealDisplay } = await import('../src/lib/e2ee/formats.ts')
const { b64url, utf8 } = await import('../src/lib/e2ee/bytes.ts')
authHooks.deregister(); hooks.deregister()

const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const time = '2026-11-17T10:00:00Z'
const DEVICE = 'conn'
const connector = { id: DEVICE, userId: 'user', name: 'Device', status: 'online' }
const project = (id, workspacePath, connectorId = DEVICE) => ({ id, name: `Project ${id}`, connectorId, workspacePath, manuallyCreated: true, pinned: false, createdAt: time, updatedAt: time, lastActivityAt: time, activeSessionCount: 0, sidebarSessionCounts: { active: 0, archived: 0 } })
const session = (id, extra = {}) => ({ id, projectId: null, connectorId: DEVICE, connectorStatus: 'online', runtime: 'codex', runtimeType: 'codex', runtimeId: 'rti', runtimeName: 'Codex', title: null, cwd: null, status: 'idle', archived: false, pinned: false, unread: false, lastReadSeq: 1, latestTurnEndSeq: 1, updatedSeq: 1, sortAt: time, lastActivityAt: time, ...extra })
const snapshot = (projects, sessions) => ({ type: 'dashboard.snapshot', projects, sessions, connectors: [connector], serverTime: time, sessionPages: { active: { hasMore: false, nextCursor: null }, archived: { hasMore: false, nextCursor: null } } })

const directoryKey = crypto.getRandomValues(new Uint8Array(32))
async function seal(key, sessionId, slot, keyId, fields) {
  return { mode: 'sealed', keyId, payload: await sealDisplay(key, displayEnvelopeAd(DEVICE, sessionId, slot, keyId), utf8(JSON.stringify(fields))) }
}

test('sealed sessions show decrypted titles, the locked placeholder, and get assigned to their project once', async (t) => {
  const runtime = startE2ee('web')
  assert.ok(runtime, 'runtime starts with WebCrypto')
  await runtime.store.savePairing({
    deviceId: DEVICE, devicePub: b64url(crypto.getRandomValues(new Uint8Array(32))), label: 'Device',
    grantedAt: time, directoryKey: { deviceId: DEVICE, keyId: 'k1', epoch: 1, key: b64url(directoryKey) },
  })

  globalThis.inventoryAuth = { session: { userId: 'user', accessToken: 'fixture-token' }, me: { displayName: 'User', role: 'admin' }, signOut() {} }
  t.mock.method(dashboardApi, 'createDashboardWsTicket', async () => ({ ticket: 'fixture-ticket' }))
  for (const name of ['listProjects', 'listSessionInventory', 'listConnectors', 'listProjectSessions', 'listSessions'])
    t.mock.method(dashboardApi, name, async () => { throw new Error(`${name} is not expected`) })

  const found = session('ses_found', {
    displayDevice: await seal(directoryKey, 'ses_found', 'device', 'k1', { title: 'Imported native', cwd: '/work/app/pkg', preview: 'done' }),
    displayUser: await seal(directoryKey, 'ses_found', 'user', 'k1', { title: 'Renamed by me' }),
  })
  const locked = session('ses_locked', {
    title: 'server plaintext must not show',
    displayDevice: await seal(crypto.getRandomValues(new Uint8Array(32)), 'ses_locked', 'device', 'k7', { title: 'Hidden', cwd: '/work/app' }),
  })
  const plain = session('ses_plain', { projectId: 'p_app', title: 'Plain session', cwd: '/work/app' })
  const projects = [project('p_app', '/work/app/'), project('p_root', '/work'), project('p_other', '/work/app/pkg', 'conn_other')]

  const patches = []
  let rejectNext = false
  t.mock.method(dashboardApi, 'patchSession', async (token, id, body) => {
    patches.push([token, id, body])
    if (rejectNext) throw Object.assign(new Error('project_not_found'), { status: 404 })
    return { session: { ...found, projectId: body.projectId, updatedSeq: 2 } }
  })

  let state
  function Probe() { state = useWorkspace(); return null }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(WorkspaceProvider, null, h(Probe), h(SidebarProvider, null, h(AppSidebar))))))
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await runtime.dispose() })

  await act(async () => { Socket.instances.at(-1).emit(snapshot(projects, [found, locked, plain])); await delay(50) })
  for (let attempt = 0; attempt < 50 && !state.sessions.some(row => row.title === 'Renamed by me'); attempt++)
    await act(async () => { await delay(10) })

  const byId = Object.fromEntries(state.sessions.map(row => [row.id, row]))
  // List: decrypted title (the user's rename wins) and cwd; the locked one shows the placeholder only.
  assert.equal(byId.ses_found.title, 'Renamed by me')
  assert.equal(byId.ses_found.cwd, '/work/app/pkg')
  assert.equal(byId.ses_found.displayState, 'decrypted')
  assert.equal(byId.ses_locked.title, '加密中，设备上线后显示')
  assert.equal(byId.ses_locked.cwd, null)
  assert.equal(byId.ses_locked.displayState, 'locked')
  // Normal mode is unchanged.
  assert.equal(byId.ses_plain.title, 'Plain session')
  assert.equal(byId.ses_plain.cwd, '/work/app')
  assert.equal(byId.ses_plain.displayState, undefined)
  // Detail: the active session carries the same decrypted fields.
  assert.equal(state.activeSession?.id, 'ses_found')
  assert.equal(state.activeSession?.title, 'Renamed by me')
  assert.equal(state.activeSession?.cwd, '/work/app/pkg')

  // Assignment: the deepest project on the same device, patched once, list entry refreshed.
  for (let attempt = 0; attempt < 50 && patches.length === 0; attempt++) await act(async () => { await delay(10) })
  await act(async () => { await delay(20) })
  assert.deepEqual(patches, [['fixture-token', 'ses_found', { projectId: 'p_app' }]])
  assert.equal(state.sessions.find(row => row.id === 'ses_found').projectId, 'p_app')
  assert.equal(state.sessions.find(row => row.id === 'ses_found').title, 'Renamed by me')
  // The sidebar renders the same rows: the unassigned locked session shows the placeholder.
  assert.match(container.textContent, /加密中，设备上线后显示/)
  assert.doesNotMatch(container.textContent, /server plaintext must not show/)

  // The Server reverting the assignment does not cause another PATCH in this app run.
  rejectNext = true
  await act(async () => { Socket.instances.at(-1).emit(snapshot(projects, [{ ...found, updatedSeq: 3 }, locked, plain])); await delay(50) })
  assert.equal(patches.length, 1)
})
