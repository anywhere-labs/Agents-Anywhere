import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const workspace = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/components/workspace-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useWorkspace = () => globalThis.modelConfigWorkspace' }
  return nextLoad(url, context)
} })
const { ModelConfigsTab } = await import('../src/components/settings/model-configs-tab.tsx')
const { modelConfigApi } = await import('../src/features/model-config/api.ts')
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

  const labels = [...container.querySelectorAll('dt')].map((item) => item.textContent)
  assert.deepEqual(labels, ['地址', 'API Key', '使用情况', '协议'])
  const values = [...container.querySelectorAll('dd')]
  assert.equal(values[0].textContent, longHost)
  // Nothing in the details is cut off with an ellipsis.
  assert.equal(container.querySelector('dl .truncate'), null)
  assert.match(values[3].textContent, /Responses21 个模型/)
  assert.match(values[3].textContent, /Anthropic自动获取模型/)

  const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent === '查看模型和地址')
  assert.ok(toggle)
  await act(async () => toggle.click())
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(container.textContent, /GPT-5 gpt-5/)
  assert.match(container.textContent, /model-19/)
  assert.match(container.textContent, new RegExp(`https://${longHost.replace(/[.]/g, '\\.')}/v1`))
  assert.match(container.textContent, /没有指定模型/)
})

async function renderTab(t, modelConfig) {
  globalThis.modelConfigWorkspace = { modelConfig, runtimes: [], refreshModelConfig: async () => {} }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(ModelConfigsTab, { token: 'fixture', connectors: [{ id: 'c', name: 'MacBook' }] }))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return container
}

const unlinked = { available: true, tokensUrl: 'https://tokens.test', secretConfigured: true, link: null, quickSetup: null }

test('one-click setup ticks only runtimes that keep their own settings and starts with them', async (t) => {
  t.mock.method(modelConfigApi, 'quickSetupCandidates', async () => ({ targets: [
    { connectorId: 'c', runtimeId: 'codex', runtimeType: 'codex', name: 'Codex', maturity: null, decision: 'apply', effect: 'restart', scope: 'instance', requiresConfirmation: false, runningSessions: 0 },
    { connectorId: 'c', runtimeId: 'dsh', runtimeType: 'dsh', name: 'DSH', maturity: null, capabilityMaturity: 'experimental', decision: 'apply', effect: 'immediate', scope: 'native_global', requiresConfirmation: true },
    { connectorId: 'c', runtimeId: 'pi', runtimeType: 'pi', name: 'Pi', maturity: 'beta', decision: 'apply', effect: 'new_instance', scope: 'instance', requiresConfirmation: false },
  ] }))
  const started = []
  t.mock.method(modelConfigApi, 'startQuickSetup', async (_token, request) => { started.push(request); return { started: true, startUrl: null } })
  const container = await renderTab(t, { secretConfigured: true, profiles: [], assignments: [], tokens: unlinked })

  assert.match(container.textContent, /Tokens Anywhere 快速配置/)
  assert.match(container.textContent, /会修改它自身的全局配置/)
  assert.match(container.textContent, /另建一个受管实例/)
  const boxes = [...container.querySelectorAll('button[role=checkbox]')].slice(0, 3)
  assert.deepEqual(boxes.map((box) => box.getAttribute('aria-checked')), ['true', 'false', 'true'])

  const start = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('一键配置'))
  await act(async () => { start.click(); await new Promise((resolve) => setTimeout(resolve, 20)) })
  assert.deepEqual(started, [{ targets: [{ connectorId: 'c', runtimeId: 'codex' }, { connectorId: 'c', runtimeId: 'pi' }], confirmNativeGlobal: false }])
})

test('a running setup shows its steps', async (t) => {
  t.mock.method(modelConfigApi, 'quickSetupCandidates', async () => ({ targets: [] }))
  const tokens = { ...unlinked, link: { status: 'linked', issuer: 'https://tokens.test', account: { id: '1', displayName: 'Ada', email: null }, linkedAt: '', relinkSoon: false },
    quickSetup: { state: 'applying', request: { targets: [{ connectorId: 'c', runtimeId: 'codex' }], confirmNativeGlobal: false }, startedAt: '' } }
  const container = await renderTab(t, { secretConfigured: true, profiles: [], assignments: [], tokens })

  assert.match(container.textContent, /已链接：Ada/)
  assert.match(container.textContent, /应用到 1 个 Runtime/)
  assert.match(container.textContent, /正在写入各设备/)
})
