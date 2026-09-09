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

function mockDevice(t, initialRuntimes = []) {
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

test('onboarding embeds one-click Agent configuration and can continue without connecting a phone', async (t) => {
  const { create } = mockDevice(t)
  const discovery = dashboardApi.discoverConnectorRuntimeTypes
  let finishDiscovery
  t.mock.method(dashboardApi, 'discoverConnectorRuntimeTypes', () => new Promise(resolve => { finishDiscovery = () => resolve(discovery()) }))
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.querySelector('[data-slide="welcome"]'))
  assert.ok(container.querySelector('img[src="/images/onboarding/desktop.webp"]'))
  await click(container, '下一页')
  assert.match(container.querySelector('h1').textContent, /测试电脑/)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal([...container.querySelectorAll('button')].some(button => button.textContent === '配置 Agent'), false)
  const panel = container.querySelector('[aria-labelledby="agent-setup-title"]')
  await until(() => finishDiscovery)
  const next = [...container.querySelectorAll('button')].find(button => button.textContent === '下一步')
  assert.equal(next.disabled, true)
  assert.match(panel.textContent, /正在发现/)
  await act(async () => finishDiscovery())
  await until(() => panel.textContent.includes('Codex'))
  assert.equal(next.disabled, false)
  assert.match(panel.textContent, /可添加/)
  await click(panel, '一键配置')
  assert.equal(create.mock.callCount(), 1)
  assert.equal(create.mock.calls[0].arguments[1], 'conn_demo')
  assert.equal(create.mock.calls[0].arguments[2].active, true)
  assert.match(panel.textContent, /已就绪/)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await click(container, '下一步')
  assert.ok(container.querySelector('[data-slide="phone"]'))
  await click(container, '下一步')
  assert.ok(container.querySelector('[data-slide="complete"]'))
  assert.match(container.textContent, /You are\nall set\./)
  assert.equal([...container.querySelectorAll('a')].find(a => a.textContent.includes('下载桌面程序')).getAttribute('href'), 'https://github.com/anywhere-labs/Agents-Anywhere/releases')
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await click(container, '立刻体验')
  assert.equal(window.location.hash, '#/')
})

test('one-click setup reuses a stopped Claude configuration and blocks continuation while starting', async (t) => {
  const runtime = { runtimeId: 'rti-claude', runtimeType: 'claude', name: 'Claude', configured: true, active: false, status: 'stopped', config: { model: 'existing-model' } }
  const { create } = mockDevice(t, [runtime])
  const saveConfig = t.mock.method(dashboardApi, 'putConnectorRuntimeConfig', async () => { throw new Error('must not overwrite the saved configuration') })
  let finishStarting
  const activate = t.mock.method(dashboardApi, 'setConnectorRuntimeActive', () => new Promise(resolve => { finishStarting = resolve }))
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.querySelector('[data-slide="welcome"]'))
  await click(container, '下一页')
  const panel = container.querySelector('[aria-labelledby="agent-setup-title"]')
  await until(() => panel.textContent.includes('Claude'))
  assert.doesNotMatch(panel.textContent, /激活/)
  await click(panel, '一键配置')
  assert.deepEqual(activate.mock.calls[0].arguments, ['test-session', 'conn_demo', 'rti-claude', true])
  assert.equal([...container.querySelectorAll('button')].find(button => button.textContent === '下一步').disabled, true)
  assert.equal(create.mock.callCount(), 0)
  assert.equal(saveConfig.mock.callCount(), 0)
  await act(async () => finishStarting({ ...runtime, active: true, status: 'running' }))
  assert.match(panel.textContent, /已就绪/)
  await click(container, '下一步')
  assert.ok(container.querySelector('[data-slide="phone"]'))
})

test('phone dialog runs download and QR confirmation before advancing to completion', async (t) => {
  mockDevice(t)
  t.mock.method(authApi, 'createMobileLoginQr', async () => ({ userId: 'user1', loginToken: 'QR-TEST', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  t.mock.method(authApi, 'mobileLoginStatus', async () => ({ status: 'pending_web_confirm', deviceName: 'iPhone 15 Pro' }))
  const confirmation = t.mock.method(authApi, 'confirmMobileLogin', async () => ({ status: 'consumed', deviceName: 'iPhone 15 Pro' }))
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.querySelector('[data-slide="welcome"]'))
  await click(container, '下一页')
  await click(container, '下一步')
  await click(container, '连接手机')
  const dialog = document.querySelector('[role="dialog"]')
  assert.match(dialog.textContent, /下载移动端 App/)
  await click(dialog, '我已安装，显示配对二维码')
  await until(() => dialog.textContent.includes('确认这次手机连接'))
  // The confirmation step names the device that scanned, so the user can verify it.
  assert.match(dialog.textContent, /iPhone 15 Pro/)
  assert.equal(container.querySelector('[data-slide="complete"]'), null)
  await click(dialog, '确认连接')
  assert.equal(confirmation.mock.calls[0].arguments[2], true)
  await until(() => dialog.textContent.includes('手机连接完成'))
  assert.match(dialog.textContent, /iPhone 15 Pro/)
  await click(dialog, '完成')
  assert.ok(container.querySelector('[data-slide="complete"]'))
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('skipping requires confirmation, and continuing the guide restores the skip trigger', async (t) => {
  const { create } = mockDevice(t)
  const qr = t.mock.method(authApi, 'createMobileLoginQr', async () => { throw new Error('must not run') })
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.querySelector('[data-slide="welcome"]'))
  await click(container, '跳过引导')
  assert.equal(container.querySelector('[data-slide="complete"]'), null)
  assert.match(document.querySelector('[role="dialog"]').textContent, /略过设备与 Agent 的配置引导/)
  await click(document.querySelector('[role="dialog"]'), '继续引导')
  assert.ok(container.querySelector('[data-slide="welcome"]'))
  assert.equal(document.activeElement.textContent, '跳过引导')
  assert.equal(window.sessionStorage.getItem('agents-anywhere.onboarding:user1:conn_demo:abcdefghijklmnop'), null)
  await click(container, '跳过引导')
  await click(document.querySelector('[role="dialog"]'), '确认跳过')
  assert.ok(container.querySelector('[data-slide="complete"]'))
  assert.equal(create.mock.callCount(), 0)
  assert.equal(qr.mock.callCount(), 0)
  assert.equal(window.sessionStorage.getItem('agents-anywhere.onboarding:user1:conn_demo:abcdefghijklmnop'), 'complete')
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
  await click(container, '我已安装，显示配对二维码')
  await until(() => container.textContent.includes('二维码已过期'))
  await click(container, '重新生成')
  await until(() => count === 2 && container.textContent.includes('二维码已过期'))
  assert.equal(completed, false)
})

test('onboarding slide buttons keep the shared pill shape', async (t) => {
  mockDevice(t)
  const container = await render(t, h(PluginOnboardingPage))
  await until(() => container.querySelector('[data-slide="welcome"]'))
  const buttons = [...container.querySelectorAll('[data-slide] button')]
  assert.ok(buttons.length >= 2, 'expected the slide actions to render')
  for (const button of buttons) {
    assert.match(button.className, /rounded-full/, `Not a pill button: ${button.textContent}`)
    assert.doesNotMatch(button.className, /rounded-lg/)
  }
})
