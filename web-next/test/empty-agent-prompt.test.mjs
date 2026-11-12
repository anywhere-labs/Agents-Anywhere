import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.scrollTo = function () { this.scrollTop = 0 }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { registerHooks } = await import('node:module')
const workspaceHook = registerHooks({ load(url, context, next) {
 if (url.endsWith('/components/workspace-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useWorkspace = () => globalThis.qaWorkspace' }
 return next(url, context)
}})
const { AuthProvider } = await import('../src/components/auth/auth-context.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
const { EmptyAgentPrompt } = await import('../src/components/empty-agent-prompt.tsx')
workspaceHook.deregister()
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const flowHash = '#/'
const account = { userId: 'user1', displayName: '测试用户', role: 'admin' }

async function render(t, children, { signedIn = true } = {}) {
  window.localStorage.clear(); window.sessionStorage.clear()
  window.history.replaceState({}, '', `/${flowHash}`)
  if (signedIn) window.localStorage.setItem('aa.session.v1', JSON.stringify({ ...account, accessToken: 'test-session' }))
  t.mock.method(authApi, 'config', async () => ({ needsBootstrap: false, registrationOpen: true }))
  t.mock.method(authApi, 'me', async () => account)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(AuthProvider, null, children))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  container.qaRoot = root
  return container
}

async function until(check) {
  for (let count = 0; count < 100; count++) {
    if (check()) return
    await act(async () => { await delay(15) })
  }
  assert.fail('Expected UI state did not arrive: ' + document.body.textContent)
}

async function click(container, label) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === label)
  assert.ok(button, `Missing button: ${label}`)
  assert.equal(button.disabled, false, `Disabled button: ${label}`)
  await act(async () => { button.click(); await delay(10) })
}

function mockDevice(t, initialRuntimes = []) {
  t.mock.method(dashboardApi, 'listConnectors', async () => ({ connectors: [{id: 'conn_demo', name: '测试电脑', status: 'online'}] }))
  let runtimes = [...initialRuntimes]
  const types = ['Codex', 'Claude'].map(name => ({
    runtimeType: name.toLowerCase(), displayName: name, present: true, available: true,
    schema: {}, defaults: {}, instancePolicy: 'single', maxInstances: 1,
  }))
  t.mock.method(dashboardApi, 'getConnector', async () => ({ connector: { id: 'conn_demo', name: '测试电脑', userId: 'user1', status: 'online' } }))
  t.mock.method(dashboardApi, 'discoverConnectorRuntimeTypes', async () => ({ runtimeTypes: types }))
  t.mock.method(dashboardApi, 'getConnectorRuntimes', async () => ({ runtimes }))
  const create = t.mock.method(dashboardApi, 'createConnectorRuntime', async (_token, _id, payload) => {
    const runtime = { ...payload, runtimeId: 'rti-codex', configured: true, active: true, status: 'running' }
    runtimes.push(runtime)
    return runtime
  })
  return { create }
}



function workspace(connectors = [{id:'conn_demo',name:'QA device',status:'online'}]) {
 globalThis.qaWorkspace={connectors,runtimes:[],isLoading:false,page:'home',routeReady:true,pairDeviceDialogOpen:false,firstDevicePromptOpen:false,refreshData(){},navigateToDevice(){}}
}
function rerender(container) {
 container.qaRoot.render(h(NextIntlClientProvider, {locale:'zh-CN',messages,timeZone:'Asia/Shanghai'}, h(AuthProvider,null,h(EmptyAgentPrompt))))
}


test('an add request settling after the device goes offline does not trap the home prompt', async t => {
  mockDevice(t); workspace()
  let finishCreate
  t.mock.method(dashboardApi, 'createConnectorRuntime', (_token, _id, payload) => new Promise(resolve => {
    finishCreate = () => resolve({ ...payload, runtimeId: 'qa-added', configured: true, active: true, status: 'running' })
  }))
  const container = await render(t, h(EmptyAgentPrompt))
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes('Codex'))
  await click(document.querySelector('[role="dialog"]'), '快速添加')
  await until(() => finishCreate)
  await act(async () => {
    workspace([{ id: 'conn_demo', name: 'QA device', status: 'offline' }])
    rerender(container)
    await delay(10)
  })
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes('请连接设备后添加 Agent'))
  assert.ok(document.querySelector('[data-slot="dialog-close"]'), 'offline content must retain a close button')
  await click(document.querySelector('[role="dialog"]'), '稍后添加')
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await act(async () => { finishCreate(); await delay(20) })
  assert.equal(document.querySelector('[role="dialog"]'), null, 'a late result must not reopen the prompt')
})

test('configured Agents on offline devices suppress the empty prompt', async t => {
  mockDevice(t, [{ configured: true, active: false, status: 'stopped' }])
  workspace([{ id: 'conn_demo', name: 'QA device', status: 'offline' }])
  await render(t, h(EmptyAgentPrompt))
  await act(async () => { await delay(30) })
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('an unavailable inventory is not treated as empty', async t => {
  mockDevice(t); workspace()
  t.mock.method(dashboardApi, 'getConnectorRuntimes', async () => { throw new Error('unavailable') })
  await render(t, h(EmptyAgentPrompt))
  await act(async () => { await delay(30) })
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('closing the prompt suppresses repeated reminders during the same entry', async t => {
  mockDevice(t); workspace()
  const container = await render(t, h(EmptyAgentPrompt))
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes('Codex'))
  await click(document.querySelector('[role="dialog"]'), '暂不添加')
  await act(async () => { workspace(); rerender(container); await delay(30) })
  assert.equal(document.querySelector('[role="dialog"]'), null)
})
