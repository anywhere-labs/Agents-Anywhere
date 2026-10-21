import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DocumentFragment']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const contextHooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/components/auth/auth-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAuth = () => globalThis.adminAuth' }
  if (url.endsWith('/components/workspace-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useWorkspace = () => globalThis.adminWorkspace' }
  if (url.endsWith('/features/desktop/desktop-connector-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useDesktopConnector = () => ({ isLocalConnector: () => false })' }
  return nextLoad(url, context)
} })
const { AdminPage } = await import('../src/components/admin/admin-page.tsx')
const { AdminSidebar } = await import('../src/components/admin/admin-sidebar.tsx')
const { SettingsPage } = await import('../src/components/pages/settings-page.tsx')
const { SettingsSidebar } = await import('../src/components/settings/settings-sidebar.tsx')
const { SidebarProvider } = await import('../src/components/ui/sidebar.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { announcementsApi } = await import('../src/features/announcements/api.ts')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
contextHooks.deregister(); hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const settings = { registrationOpen: true, oauthRegistrationOpen: true, passwordResetEnabled: false, oauth: null, email: { enabled: false, fromAddress: '', apiKeyConfigured: false } }
const serviceInfo = { endpoint: 'https://fixture.example', version: '2.1.0', database: 'postgresql', databasePath: null, startedAt: '2026-10-08T00:00:00Z', uptimeSeconds: 60, serverTime: '2026-10-08T00:01:00Z' }

async function render(t, element, { role = 'admin', section = 'overview', tab = 'account', sidebar = false } = {}) {
  globalThis.adminAuth = {
    me: { userId: 'user', displayName: 'User', role, disabled: false },
    session: { userId: 'user', accessToken: 'fixture-token' },
    signOut: t.mock.fn(),
    refreshConfig: async () => {},
    refreshMe: async () => globalThis.adminAuth.me,
  }
  globalThis.adminWorkspace = {
    adminSection: section,
    settingsTab: tab,
    navigate: t.mock.fn(),
    goHome: t.mock.fn(),
    openSession() {},
    upsertSession() {},
    refreshData() {},
    projects: [],
    sessions: [],
    isLoading: false,
    sidebarShowsSessions: false,
    sidebarCompactSessions: false,
    setSidebarShowsSessions() {},
    setSidebarCompactSessions() {},
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const tree = h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, sidebar ? h(SidebarProvider, null, element) : element)
  await act(async () => root.render(tree))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return container
}
const buttonNamed = (container, text) => [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)

test('a member never mounts an administration page or requests its data', async (t) => {
  const users = t.mock.method(authApi, 'listUsers', async () => ({ users: [], total: 0 }))
  const container = await render(t, h(AdminPage), { role: 'member', section: 'team' })
  assert.equal(container.textContent, '')
  assert.equal(users.mock.callCount(), 0)
})

test('the announcement page edits the publication without reading service settings', async (t) => {
  const service = t.mock.method(authApi, 'getSettings', async () => settings)
  t.mock.method(announcementsApi, 'settings', async () => ({ enabled: true, markdown: '公告内容', publishedAt: '2026-10-08T00:00:00Z' }))
  const save = t.mock.method(announcementsApi, 'save', async (_token, payload) => ({ ...payload, publishedAt: '2026-10-08T00:00:00Z' }))
  const container = await render(t, h(AdminPage), { section: 'announcements' })
  assert.equal(container.querySelector('h1').textContent, '公告')
  await act(async () => container.querySelector('[role="switch"]').click())
  await act(async () => container.querySelector('[data-slot="card-footer"] button').click())
  assert.equal(save.mock.callCount(), 1)
  assert.equal(save.mock.calls[0].arguments[1].enabled, false)
  assert.equal(service.mock.callCount(), 0)
})

test('service settings are split into pages and no page carries the announcement card', async (t) => {
  t.mock.method(authApi, 'getSettings', async () => settings)
  t.mock.method(authApi, 'getServiceInfo', async () => serviceInfo)
  const update = t.mock.method(authApi, 'updateSettings', async (_token, patch) => ({ ...settings, ...patch }))
  const announcement = t.mock.method(announcementsApi, 'settings', async () => { throw new Error('Announcements have their own page') })

  const general = await render(t, h(AdminPage), { section: 'service-general' })
  assert.equal(general.querySelector('h1').textContent, '常规')
  assert.ok(general.querySelector('[role="switch"]'), 'the access switches live on the general page')
  assert.doesNotMatch(general.textContent, /postgresql/)
  await act(async () => general.querySelector('[role="switch"]').click())
  assert.deepEqual(update.mock.calls[0].arguments[1], { registrationOpen: false })

  const info = await render(t, h(AdminPage), { section: 'service-info' })
  assert.equal(info.querySelector('h1').textContent, '服务信息')
  assert.match(info.textContent, /postgresql/)
  assert.equal(info.querySelector('[role="switch"]'), null)

  const auth = await render(t, h(AdminPage), { section: 'service-auth' })
  assert.equal(auth.querySelector('h1').textContent, '身份认证')
  assert.match(auth.textContent, /agents-anywhere-desktop/)
  assert.match(auth.textContent, /\/api\/v2\/auth\/oauth\/callback/, 'the web callback lives under the API namespace')
  assert.equal(announcement.mock.callCount(), 0)
})

const percentiles = { p50: null, p90: null, p99: null, samples: 0 }
const quietReport = {
  range: { fromDate: '2026-10-01', toDate: '2026-10-07', timezone: 'Asia/Shanghai', dataSince: '2026-10-01', generatedAt: '2026-10-08T00:00:00Z' },
  summary: {
    activeUsers: 3, newUsers: 0, avgDau: 1, wau: 3, mau: 3, totalUsers: 5,
    messages: 40, sessions: 6, sessionViews: 21, sessionsViewed: 9, sessionsReadOnly: 4,
    turns: 30, turnFailureRate: null, turnDurationMs: percentiles,
    approvalsRequested: 0, approvalsResolved: 0, approvalWaitMs: percentiles,
    runtimeErrors: 0, connectorsOnline: 1, totalConnectors: 2,
  },
  daily: [],
  hourOfDay: [],
  users: { segments: [], messageHistogram: [], retention: [] },
  runtimes: [],
  devices: { totalConnectors: 2, connectorsSeen7d: 1, connectorsSeen30d: 2, byOs: [], inventoryDaily: [], inventoryAsOf: 'live' },
  quality: { turnOutcomes: [], turnDurationMs: percentiles, approvalOutcomes: [], approvalWaitMs: percentiles, runtimeErrors: 0 },
  serverTime: '2026-10-08T00:00:00Z',
}

test('the usage section tells read-only sessions and opens apart from active sessions', async (t) => {
  t.mock.method(dashboardApi, 'getAdminUsageReport', async () => quietReport)
  t.mock.method(dashboardApi, 'getAdminUsageLive', async () => { throw new Error('offline') })
  const container = await render(t, h(AdminPage), { section: 'usage' })
  assert.match(container.textContent, /活跃会话6/)
  assert.match(container.textContent, /只读会话4共读过 9 个会话/)
  assert.match(container.textContent, /读取次数21/)
  assert.match(container.textContent, /每日会话/)
  const overview = await render(t, h(AdminPage), { section: 'overview' })
  assert.match(overview.textContent, /活跃会话6另有 4 个只读/)
})

test('usage board sections come from the route and keep the board header', async (t) => {
  const report = t.mock.method(dashboardApi, 'getAdminUsageReport', async () => { throw new Error('fixture report failure') })
  t.mock.method(dashboardApi, 'getAdminUsageLive', async () => { throw new Error('offline') })
  const container = await render(t, h(AdminPage), { section: 'usage' })
  assert.equal(container.querySelector('h1').textContent, '使用量')
  assert.equal(report.mock.callCount(), 1)
  assert.equal(report.mock.calls[0].arguments[0], 'fixture-token')
  assert.ok(report.mock.calls[0].arguments[1].tz)
  assert.match(container.textContent, /fixture report failure/)
  assert.equal(container.querySelector('[role="tablist"]'), null, 'the in-page tab strip moved to the sidebar')
})

test('the administration sidebar lists both groups and navigates by section', async (t) => {
  const container = await render(t, h(AdminSidebar), { section: 'overview', sidebar: true })
  assert.match(container.textContent, /数据/)
  assert.match(container.textContent, /团队与公告/)
  assert.match(container.textContent, /服务/)
  const items = [...container.querySelectorAll('[data-sidebar="menu-button"]')].map((button) => button.textContent.trim())
  assert.deepEqual(items, ['返回主页', '概览', '用户', '使用量', '设备与 Runtime', '运行质量', '团队', '公告', '常规', '身份认证', '邮件', '服务信息'])
  assert.match(container.textContent, /服务/)
  assert.equal(container.querySelector('[aria-current="page"]').textContent.trim(), '概览')
  await act(async () => buttonNamed(container, '团队').click())
  assert.deepEqual(globalThis.adminWorkspace.navigate.mock.calls.at(-1).arguments, ['admin', 'team'])
  await act(async () => buttonNamed(container, '返回主页').click())
  assert.equal(globalThis.adminWorkspace.goHome.mock.callCount(), 1)
})

test('the settings sidebar drives the settings tab and the page shows the active tab as its title', async (t) => {
  const sidebar = await render(t, h(SettingsSidebar), { tab: 'appearance', sidebar: true })
  assert.equal(sidebar.querySelector('[aria-current="page"]').textContent.trim(), '外观')
  await act(async () => buttonNamed(sidebar, '已归档会话').click())
  assert.deepEqual(globalThis.adminWorkspace.navigate.mock.calls.at(-1).arguments, ['settings', 'archived-sessions'])

  t.mock.method(authApi, 'me', async () => globalThis.adminAuth.me)
  const page = await render(t, h(SettingsPage), { tab: 'appearance' })
  assert.equal(page.querySelector('h1').textContent, '外观')
  assert.ok(page.querySelector('[role="radiogroup"]'))
  assert.equal(page.querySelector('nav'), null, 'the inner category navigation moved to the sidebar')
})
