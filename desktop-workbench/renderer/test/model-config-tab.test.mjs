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
