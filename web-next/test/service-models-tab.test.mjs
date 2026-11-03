import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const workspace = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/components/workspace-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useWorkspace = () => globalThis.serviceModelsWorkspace' }
  return nextLoad(url, context)
} })
const { ServiceModelsTab } = await import('../src/components/settings/service-models-tab.tsx')
const { modelConfigApi } = await import('../src/features/model-config/api.ts')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
workspace.deregister(); hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))

const codex = {
  connectorId: 'c', runtimeId: 'codex', runtimeType: 'codex', displayName: 'Codex', name: 'Codex', present: true, active: true, status: 'running',
  config: { modelGateway: { baseUrl: 'https://tokens.test/v1' }, customModels: [{ modelId: 'gpt-5', displayName: 'GPT-5' }], model: { modelId: 'gpt-5' } },
  modelConnection: { maturity: 'stable', protocols: ['openai_responses'], modelField: 'model', modeField: null, scope: 'instance', apply: 'restart' },
  modelConnectionStatus: { state: 'applied' },
}
const dsh = { ...codex, runtimeId: 'dsh', name: 'DSH', modelConnection: { ...codex.modelConnection, modelField: undefined } }
const tokens = {
  id: 'tokens', source: 'tokens', name: 'Anywhere', state: 'active',
  offers: [{ format: 'openai_responses', baseUrl: 'https://tokens.test/v1', models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-5-mini', name: 'GPT-5 Mini' }] }],
}

async function render(t, runtimes) {
  globalThis.serviceModelsWorkspace = {
    modelConfig: { secretConfigured: true, profiles: [tokens], assignments: [{ connectorId: 'c', runtimeId: 'codex', profileId: 'tokens', status: 'applied', modelConnectionStatus: { state: 'applied' } }] },
    runtimes,
    refreshModelConfig: async () => {},
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(ServiceModelsTab, { token: 'fixture', connectors: [{ id: 'c', name: 'MacBook', status: 'online' }] }))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return container
}

test('each device lists runtimes that take a model, with channel and model', async (t) => {
  t.mock.method(dashboardApi, 'getConnectorRuntimeModelCatalog', async () => ({ catalog: { runtime: 'codex', revision: 1, models: [] } }))
  const container = await render(t, [codex, dsh])
  assert.match(container.textContent, /MacBook/)
  assert.doesNotMatch(container.textContent, /DSH/)
  const [channel, model] = container.querySelectorAll('select')
  assert.equal(channel.value, 'tokens')
  assert.deepEqual([...channel.options].map((option) => option.textContent), ['Anywhere', '本机配置'])
  assert.equal(model.value, 'gpt-5')
})

test('a model on the channel in use saves only the model', async (t) => {
  t.mock.method(dashboardApi, 'getConnectorRuntimeModelCatalog', async () => ({ catalog: { runtime: 'codex', revision: 1, models: [] } }))
  const saved = []
  t.mock.method(dashboardApi, 'putConnectorRuntimeConfig', async (_token, connectorId, runtimeId, config) => { saved.push({ connectorId, runtimeId, config }); return codex })
  const applied = []
  t.mock.method(modelConfigApi, 'apply', async (...args) => { applied.push(args); return { results: [] } })
  const container = await render(t, [codex])
  const model = container.querySelectorAll('select')[1]
  await act(async () => {
    model.value = 'gpt-5-mini'
    model.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(applied.length, 0)
  assert.deepEqual(saved, [{ connectorId: 'c', runtimeId: 'codex', config: { ...codex.config, model: { modelId: 'gpt-5-mini' } } }])
})

test('an offline device shows what is saved without pickers', async (t) => {
  t.mock.method(dashboardApi, 'getConnectorRuntimeModelCatalog', async () => { throw new Error('not called') })
  const container = await render(t, [{ ...codex, status: 'stopped' }])
  assert.equal(container.querySelectorAll('select').length, 0)
  assert.match(container.textContent, /Anywhere/)
  assert.match(container.textContent, /gpt-5/)
})
