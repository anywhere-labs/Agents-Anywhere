import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'DocumentFragment', 'CustomEvent', 'KeyboardEvent', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const workspace = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/components/workspace-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useWorkspace = () => globalThis.modelConfigWorkspace; export const useOptionalWorkspace = () => globalThis.modelConfigWorkspace ?? null' }
  return nextLoad(url, context)
} })
const { ModelConfigsTab } = await import('../src/components/settings/model-configs-tab.tsx')
const { modelConfigApi } = await import('../src/features/model-config/api.ts')
const { ApiError } = await import('../src/lib/api/errors.ts')
workspace.deregister(); hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))

const longHost = 'a-very-long-gateway-name-that-does-not-fit.region.internal.example.test:8443'
const models = Array.from({ length: 20 }, (_, index) => ({ id: `model-${index}` }))
const profile = {
  id: 'mpr_1', source: 'manual', name: '通用模型网关（演示）', originHost: longHost, keyHint: 'sk-demo…0000', strategyName: null,
  state: 'active', etag: '1', updatedAt: '2026-11-03T00:00:00Z',
  offers: [
    { format: 'openai_responses', baseUrl: `https://${longHost}/v1`, models: [{ id: 'gpt-5', name: 'GPT-5' }, ...models] },
    { format: 'anthropic', baseUrl: `https://${longHost}`, models: [] },
  ],
}

test('a model profile labels each detail and shows it in full', async (t) => {
  globalThis.modelConfigWorkspace = {
    modelConfig: { secretConfigured: true, profiles: [profile], assignments: [] },
    runtimes: [],
    refreshModelConfig: async () => {},
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(ModelConfigsTab, { token: 'fixture', connectors: [] }))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  // Without a channel reported, the page opens on the first channel listed.
  const nav = container.querySelector('nav')
  assert.equal(nav.querySelector('[aria-current="true"]').textContent, '通用模型网关（演示）')
  await act(async () => { [...nav.querySelectorAll('button')].find((button) => button.textContent.includes('通用模型网关')).click() })

  // The selected channel's summary comes first; its offers are listed open below it.
  const summary = container.querySelector('dl')
  const labels = [...summary.querySelectorAll(':scope > dt')].map((item) => item.textContent)
  assert.deepEqual(labels, ['地址', 'API Key', '使用情况', '协议'])
  const values = [...summary.querySelectorAll(':scope > dd')]
  assert.equal(values[0].textContent, longHost)
  // Nothing in the details is cut off with an ellipsis.
  assert.equal(container.querySelector('dl .truncate'), null)
  assert.match(values[3].textContent, /Responses21 个模型/)
  assert.match(values[3].textContent, /Anthropic自动获取模型/)

  const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent === '收起')
  assert.ok(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(container.textContent, /GPT-5 gpt-5/)
  assert.match(container.textContent, /model-19/)
  assert.match(container.textContent, new RegExp(`https://${longHost.replace(/[.]/g, '\\.')}/v1`))
  assert.match(container.textContent, /没有指定模型/)
})

const linked = { available: true, tokensUrl: 'https://tokens.test', secretConfigured: true,
  link: { status: 'linked', issuer: 'https://tokens.test', account: { id: '1', displayName: 'Ada', email: null }, linkedAt: '2026-11-03T00:00:00Z', relinkSoon: false } }
const unlinked = { ...linked, link: null }
const connectors = [{ id: 'c', name: 'MacBook', status: 'online' }, { id: 'd', name: 'Studio', status: 'offline' }]
const runtimes = [
  { connectorId: 'c', runtimeId: 'codex', runtimeType: 'codex', name: 'Codex', modelConnection: { scope: 'instance' } },
  { connectorId: 'c', runtimeId: 'claude', runtimeType: 'claude', name: 'Claude Code', modelConnection: { scope: 'instance' } },
  { connectorId: 'c', runtimeId: 'dsh', runtimeType: 'dsh', name: 'DSH', modelConnection: { scope: 'native_global' } },
  { connectorId: 'c', runtimeId: 'shell', runtimeType: 'shell', name: 'Shell', modelConnection: null },
  { connectorId: 'd', runtimeId: 'codex', runtimeType: 'codex', name: 'Codex', modelConnection: { scope: 'instance' } },
]
const row = (connectorId, runtimeId, state, extra = {}) => ({
  connectorId, runtimeId, override: null, desired: 'mpr_1', actual: state === 'applied' ? 'mpr_1' : 'native', state,
  step: null, reason: null, message: null, runningSessions: 0, updatedAt: null, ...extra,
})
const channelState = (runtimesState, extra = {}) => ({ channel: 'mpr_1', revision: 4, switch: { revision: 4, state: 'running', startedAt: '', finishedAt: null }, runtimes: runtimesState, ...extra })
const tokensProfile = { ...profile, id: 'mpr_t', source: 'tokens', name: 'Tokens Anywhere', originHost: 'tokens.test', offers: [] }

async function renderTab(t, modelConfig) {
  // The Anywhere account page reads its account and usage; they never answer here.
  t.mock.method(modelConfigApi, 'tokensAccount', async () => new Promise(() => {}))
  t.mock.method(modelConfigApi, 'tokensUsage', async () => new Promise(() => {}))
  globalThis.modelConfigWorkspace = { modelConfig, runtimes, refreshModelConfig: async () => {} }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(ModelConfigsTab, { token: 'fixture', connectors }))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return container
}

const buttons = (root, text) => [...root.querySelectorAll('button')].filter((button) => button.textContent.trim() === text)
const click = async (element) => act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 10)) })
async function choose(select, value) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}
const navItem = (container, name) => [...container.querySelectorAll('nav button')].find((button) => button.textContent.includes(name))
const runtimesRegion = (container) => [...container.querySelectorAll('[role=region]')]
  .find((region) => region.querySelector('[role=heading]')?.textContent === 'Runtime')
const statusText = (container) => runtimesRegion(container).querySelector('span[role=status]')?.textContent

test('channels are listed on the left with the applied one marked and opened first', async (t) => {
  const second = { ...profile, id: 'mpr_2', name: '公司网关' }
  const container = await renderTab(t, { secretConfigured: true, profiles: [profile, second], assignments: [], tokens: unlinked,
    channel: channelState([], { channel: 'mpr_2', switch: null }) })

  const nav = container.querySelector('nav')
  const names = [...nav.querySelectorAll('button[type="button"]')].map((button) => button.textContent)
  // The device's own configuration is not listed; signing out of Tokens Anywhere returns to it.
  assert.deepEqual(names, ['Tokens Anywhere', '通用模型网关（演示）', '公司网关已应用'])
  // The page opens on the applied channel; there is no channel card above the list.
  assert.equal(nav.querySelector('[aria-current="true"]').textContent, '公司网关已应用')
  const pane = container.querySelector('section')
  assert.match(pane.textContent, /公司网关/)
  // The applied channel cannot be deleted, and needs no button to apply it.
  assert.equal(pane.querySelector('button[aria-label="删除配置"]').disabled, true)
  assert.equal(buttons(pane, '应用').length, 0)
  // With no runtime on it, the page shows no runtime list.
  assert.equal(runtimesRegion(container), undefined)

  // Not linked, Tokens Anywhere offers only the link.
  await click(navItem(container, 'Tokens Anywhere'))
  assert.equal(buttons(container, '链接账户').length, 1)
  assert.equal(buttons(container, '应用').length, 0)
})

test('a channel chosen in the list is applied from its page', async (t) => {
  const calls = []
  t.mock.method(modelConfigApi, 'setChannel', async (_token, channel) => { calls.push(channel); return channelState([], { channel, revision: 9 }) })
  const container = await renderTab(t, { secretConfigured: true, profiles: [profile], assignments: [], channel: channelState([], { channel: 'native', switch: null }) })

  // On the device's own configuration, nothing in the list is marked applied.
  assert.equal(navItem(container, '设备自带配置'), undefined)
  assert.equal([...container.querySelectorAll('nav button')].some((button) => button.textContent.endsWith('已应用')), false)
  await click(navItem(container, '通用模型网关'))
  const pane = container.querySelector('section')
  assert.equal(pane.querySelector('button[aria-label="删除配置"]').disabled, false)
  await click(buttons(pane, '应用')[0])
  assert.deepEqual(calls, ['mpr_1'])
  // The answer shows at once, before the next push.
  assert.equal(navItem(container, '通用模型网关').textContent, '通用模型网关（演示）已应用')
  assert.equal(buttons(container.querySelector('section'), '应用').length, 0)
})

test('each channel counts its own runtimes switching, done or failed', async (t) => {
  const running = await renderTab(t, { secretConfigured: true, profiles: [profile], assignments: [], channel: channelState([
    row('c', 'codex', 'applied'),
    row('d', 'codex', 'waiting_online'),
    row('c', 'dsh', 'switching', { step: 'activating' }),
    row('c', 'shell', 'unsupported', { reason: 'model_connection_unsupported' }),
  ]) })
  assert.equal(statusText(running), '正在切换 1/3 个 Runtime · 1 台设备离线，上线后切换')
  assert.equal(running.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '1')
  // The list shows the count and that it is still switching.
  const item = navItem(running, '通用模型网关')
  assert.match(item.textContent, /3$/)
  assert.ok(item.querySelector('[aria-label="正在切换"]'))

  const done = await renderTab(t, { secretConfigured: true, profiles: [profile], assignments: [], channel: channelState([
    row('c', 'codex', 'applied'), row('d', 'codex', 'applied'),
    // A runtime chosen for another channel is counted there.
    row('c', 'claude', 'applied', { override: 'native', desired: 'native', actual: 'native' }),
  ], { switch: { revision: 4, state: 'done', startedAt: '', finishedAt: '' } }) })
  assert.equal(statusText(done), '已在 2 个 Runtime 生效')
  assert.equal(done.querySelector('[role=progressbar]'), null)
  assert.equal(done.querySelector('[data-runtime="c/claude"]'), null)

  const retried = []
  t.mock.method(modelConfigApi, 'retryChannel', async (_token, target) => { retried.push(target); return channelState([]) })
  const attention = await renderTab(t, { secretConfigured: true, profiles: [profile], assignments: [], channel: channelState([
    row('c', 'codex', 'applied'), row('d', 'codex', 'restored', { reason: 'verify_failed' }),
  ], { switch: { revision: 4, state: 'attention', startedAt: '', finishedAt: '' } }) })
  assert.equal(statusText(attention), '1/2 已生效 · 1 个切换失败，已恢复原网关')
  assert.ok(navItem(attention, '通用模型网关').querySelector('[aria-label="有 Runtime 需要处理"]'))
  await click(buttons(runtimesRegion(attention), '重试')[0])
  assert.deepEqual(retried, [undefined])
})

test('runtimes are listed by device without expanding, each naming the channel it is on', async (t) => {
  const container = await renderTab(t, { secretConfigured: true, profiles: [profile], assignments: [], channel: channelState([
    row('c', 'codex', 'applied'),
    row('c', 'claude', 'pending'),
    row('d', 'codex', 'applied'),
    row('c', 'shell', 'unsupported', { reason: 'model_connection_unsupported' }),
  ]) })

  assert.equal(buttons(container, '详情').length, 0)
  const mac = container.querySelector('[data-device="c"]')
  const studio = container.querySelector('[data-device="d"]')
  assert.match(mac.textContent, /Codex已生效/)
  // Until it switches, a runtime says which channel it still uses.
  assert.match(mac.textContent, /Claude Code排队中 · 当前使用「设备自带配置」/)
  assert.match(studio.querySelector('[data-runtime="d/codex"]').textContent, /已生效/)
  assert.ok(studio.querySelector('[aria-label="离线"]'))
  // Runtimes that cannot switch stay in view at the end.
  assert.match(runtimesRegion(container).textContent, /1 个 Runtime 不支持/)
  assert.match(container.querySelector('[data-runtime="c/shell"]').textContent, /不支持 · 不支持模型连接/)
  // The list shows the channel; runtimes are not moved one by one here.
  assert.equal(container.querySelector('[data-runtime] select'), null)
  assert.match(container.querySelector('[data-runtime="c/codex"]').textContent, /通用模型网关（演示）$/)
})

test('a runtime offers retry only after a failed switch, and says why it cannot follow', async (t) => {
  const retried = []
  t.mock.method(modelConfigApi, 'retryChannel', async (_token, target) => { retried.push(`${target.connectorId}/${target.runtimeId}`); return channelState([]) })
  const container = await renderTab(t, { secretConfigured: true, profiles: [profile], assignments: [], channel: channelState([
    row('c', 'codex', 'pending'),
    row('c', 'claude', 'restored', { reason: 'verify_failed' }),
    row('c', 'dsh', 'unsupported', { reason: 'confirmation_required' }),
  ], { switch: { revision: 4, state: 'attention', startedAt: '', finishedAt: '' } }) })

  assert.equal(buttons(container.querySelector('[data-runtime="c/codex"]'), '重试').length, 0)
  assert.match(container.querySelector('[data-runtime="c/claude"]').textContent, /切换失败，已恢复原网关 · Runtime 回报的连接与目标不一致/)
  assert.match(container.querySelector('[data-runtime="c/dsh"]').textContent, /需要单独指定并确认/)
  await click(buttons(container.querySelector('[data-runtime="c/claude"]'), '重试')[0])
  assert.deepEqual(retried, ['c/claude'])
})

test('a linked Tokens Anywhere account offers to be applied, signs out and counts its runtimes', async (t) => {
  const container = await renderTab(t, { secretConfigured: true, profiles: [tokensProfile], assignments: [], tokens: linked, channel: channelState([
    row('c', 'codex', 'pending', { desired: 'native', actual: 'tokens' }),
  ], { channel: 'native' }) })

  await click(navItem(container, 'Tokens Anywhere'))
  const pane = container.querySelector('section')
  assert.match(pane.textContent, /Tokens Anywhere 账户/)
  assert.equal(buttons(pane, '应用').length, 1)
  assert.equal(buttons(pane, '退出').length, 1)
  assert.equal(buttons(pane, '切换账号').length, 0)
  assert.match(pane.textContent, /1 个 Runtime 在用/)
  assert.match(runtimesRegion(container).textContent, /还没有 Runtime 使用这个网关/)
})

test('signing out moves the runtimes on Tokens Anywhere to the default first, then unlinks', async (t) => {
  const calls = []
  let unlinks = 0
  t.mock.method(modelConfigApi, 'setChannel', async (_token, channel) => {
    calls.push(['channel', channel])
    return channelState([
      row('c', 'codex', 'switching', { desired: 'native', actual: 'tokens' }),
      row('c', 'claude', 'applied', { override: 'tokens', desired: 'tokens', actual: 'tokens' }),
    ], { channel, revision: 5 })
  })
  t.mock.method(modelConfigApi, 'setRuntimeChannel', async (_token, target, channel) => {
    calls.push(['runtime', `${target.connectorId}/${target.runtimeId}`, channel])
    return channelState([
      row('c', 'codex', 'applied', { desired: 'native', actual: 'native' }),
      row('c', 'claude', 'applied', { desired: 'native', actual: 'native' }),
    ], { channel: 'native', revision: 6 })
  })
  // Still in use at first: the page tries again once nothing is on Tokens Anywhere.
  t.mock.method(modelConfigApi, 'unlinkTokens', async () => {
    unlinks += 1
    if (unlinks === 1) throw new ApiError({ status: 409, detail: 'in use', kind: 'http', code: 'channel_in_use' })
    return { revoked: true }
  })
  const container = await renderTab(t, { secretConfigured: true, profiles: [tokensProfile], assignments: [], tokens: linked, channel: channelState([
    row('c', 'codex', 'applied', { desired: 'tokens', actual: 'tokens' }),
    row('c', 'claude', 'applied', { override: 'tokens', desired: 'tokens', actual: 'tokens' }),
  ], { channel: 'tokens', switch: null }) })

  await click(buttons(container.querySelector('section'), '退出')[0])
  const dialog = document.body.querySelector('[role=alertdialog]')
  assert.match(dialog.textContent, /改用「设备自带配置」/)
  await click(buttons(dialog, '退出')[0])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  assert.deepEqual(calls, [['channel', 'native'], ['runtime', 'c/claude', null]])
  assert.equal(unlinks, 2)
  // The applied channel moved, but the page stays on Tokens Anywhere.
  assert.equal(container.querySelector('nav [aria-current="true"]').textContent, 'Tokens Anywhere')
})
