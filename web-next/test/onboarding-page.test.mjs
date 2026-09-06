import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/' })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AuthProvider, useAuth } = await import('../src/components/auth/auth-context.tsx')
const { PluginOnboardingPage } = await import('../src/components/onboarding/plugin-onboarding-page.tsx')
const { MobileConnectionContent } = await import('../src/components/pages/mobile-signin-panel.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const flowHash = '#/onboarding?source=dsh-plugin&connectorId=conn_demo&flowId=abcdefghijklmnop'
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

function mockDevice(t) {
  let runtimes = []
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

test('Web onboarding configures available Agents and can skip phone to finish without any Dialog', async (t) => {
  const { create } = mockDevice(t)
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.textContent.includes('Codex') && container.textContent.includes('Claude'))
  assert.equal(container.querySelector('[role="dialog"]'), null)
  await click(container, '快速添加')
  assert.equal(create.mock.callCount(), 1)
  assert.equal(create.mock.calls[0].arguments[1], 'conn_demo')
  await click(container, '下一步')
  assert.match(container.textContent, /也在手机上使用/)
  await click(container, '暂时跳过')
  assert.match(container.textContent, /设置完成/)
  assert.equal([...container.querySelectorAll('a')].find(a => a.textContent.includes('立即体验')).getAttribute('href'), '#/')
  assert.ok([...container.querySelectorAll('button')].find(button => button.textContent.includes('下载桌面端')).disabled)
  assert.match(container.textContent, /官网即将上线/)
  assert.equal(container.querySelector('[role="dialog"]'), null)
})

test('Web onboarding embeds download and scan pages and requires phone confirmation before completion', async (t) => {
  mockDevice(t)
  t.mock.method(authApi, 'createMobileLoginQr', async () => ({ userId: 'user1', loginToken: 'QR-TEST', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  t.mock.method(authApi, 'mobileLoginStatus', async () => ({ status: 'pending_web_confirm' }))
  const confirmation = t.mock.method(authApi, 'confirmMobileLogin', async () => ({ status: 'consumed' }))
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.textContent.includes('Codex'))
  await click(container, '下一步')
  await click(container, '连接手机')
  assert.match(container.textContent, /下载移动端 App/)
  await click(container, '我已安装，继续')
  await until(() => container.textContent.includes('确认这次手机连接'))
  assert.doesNotMatch(container.textContent, /设置完成/)
  await click(container, '确认连接')
  assert.equal(confirmation.mock.calls[0].arguments[2], true)
  await click(container, '完成')
  assert.match(container.textContent, /设置完成/)
  assert.equal(container.querySelector('[role="dialog"]'), null)
})

test('an unauthorized target never triggers Agent discovery', async (t) => {
  t.mock.method(dashboardApi, 'getConnector', async () => ({ connector: { id: 'conn_demo', userId: 'someone-else', status: 'online' } }))
  const discover = t.mock.method(dashboardApi, 'discoverConnectorRuntimeTypes', async () => { throw new Error('must not run') })
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.textContent.includes('不属于当前账号'))
  assert.equal(discover.mock.callCount(), 0)
})

test('login after navigating to registration returns to the original onboarding URL', async (t) => {
  let auth
  function Capture() { auth = useAuth(); return null }
  await render(t, h(Capture), { signedIn: false })
  t.mock.method(authApi, 'login', async () => ({ ...account, accessToken: 'new-test-session' }))
  await until(() => !auth.loading)
  await act(async () => { auth.navigate('register'); await delay(10) })
  await act(async () => { await auth.login({ email: 'test@example.test', password: 'test-password' }); await delay(10) })
  assert.equal(window.location.hash, flowHash)
  assert.equal(auth.screen, 'onboarding')
})

test('an expired phone QR can be regenerated without reporting a completed connection', async (t) => {
  let count = 0
  t.mock.method(authApi, 'createMobileLoginQr', async () => ({ userId: 'user1', loginToken: `QR-${++count}`, expiresAt: new Date().toISOString() }))
  t.mock.method(authApi, 'mobileLoginStatus', async () => ({ status: 'expired' }))
  let completed = false
  const container = await render(t, h(MobileConnectionContent, { token: 'test-session', userId: 'user1', onComplete: () => { completed = true }, onCancel: () => {} }))
  await click(container, '我已安装，继续')
  await until(() => container.textContent.includes('二维码已过期'))
  await click(container, '重新生成')
  await until(() => count === 2 && container.textContent.includes('二维码已过期'))
  assert.equal(completed, false)
})
