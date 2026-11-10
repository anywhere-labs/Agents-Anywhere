import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AuthProvider, useAuth } = await import('../src/components/auth/auth-context.tsx')
const { TokensAnywhereOAuthFlow } = await import('../src/components/auth/mobile-oauth-page.tsx')
const { LoginScreen } = await import('../src/components/auth/login-screen.tsx')
const { RegisterScreen } = await import('../src/components/auth/register-screen.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const params = new URLSearchParams({ response_type: 'code', client_id: 'tokens-anywhere', redirect_uri: 'https://api.example.test/oauth/aa', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', scope: 'profile email', state: 'browser-state' })
const hash = `#/tokens-anywhere-oauth?${params}`
const account = { userId: 'usr_example', email: 'user@example.test', displayName: 'Alice', role: 'member' }
let auth
function AuthScreens() {
  auth = useAuth()
  if (auth.screen === 'register') return h(RegisterScreen)
  if (auth.screen === 'login') return h(LoginScreen)
  return h(TokensAnywhereOAuthFlow)
}
async function render(t, signedIn = true) {
  window.localStorage.clear(); window.sessionStorage.clear()
  window.history.replaceState({}, '', `/${hash}`)
  if (signedIn) window.localStorage.setItem('aa.session.v1', JSON.stringify({ ...account, accessToken: 'aa-session' }))
  t.mock.method(authApi, 'config', async () => ({ needsBootstrap: false, registrationOpen: true, emailVerificationRequired: false }))
  t.mock.method(authApi, 'me', async () => account)
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'en', messages, timeZone: 'UTC' }, h(AuthProvider, null, h(AuthScreens)))))
  t.after(async () => { await act(async () => root.unmount()); node.remove() })
  return node
}
async function click(node, label) {
  const button = [...node.querySelectorAll('button')].find(item => item.textContent === label)
  assert.ok(button, `Missing ${label}`)
  await act(async () => button.click())
}

test('existing session requires explicit approval and sends the original PKCE request', async t => {
  const authorize = t.mock.method(authApi, 'authorizeOAuth', async () => ({ redirectUrl: 'https://app.example.test/#/complete' }))
  const node = await render(t)
  assert.match(node.textContent, /Alice/)
  assert.match(node.textContent, /name, email address and avatar/)
  assert.equal(authorize.mock.callCount(), 0)
  await click(node, 'Continue to Tokens Anywhere')
  assert.equal(authorize.mock.callCount(), 1)
  assert.deepEqual(authorize.mock.calls[0].arguments, ['aa-session', { ...Object.fromEntries(params), approved: true }])
  assert.equal(window.location.hash, '#/complete')
})

test('cancellation is sent to the server for callback validation', async t => {
  const authorize = t.mock.method(authApi, 'authorizeOAuth', async () => ({ redirectUrl: 'https://app.example.test/#/cancelled' }))
  const node = await render(t)
  await click(node, 'Cancel')
  assert.equal(authorize.mock.calls[0].arguments[1].approved, false)
  assert.equal(authorize.mock.calls[0].arguments[1].state, 'browser-state')
})

test('switching accounts retains the authorization request and presents login', async t => {
  const node = await render(t)
  await click(node, 'Use another account')
  assert.ok(node.querySelector('#login-email'))
  assert.equal(window.location.hash, hash)
  assert.equal(window.localStorage.getItem('aa.session.v1'), null)
})

for (const operation of ['login', 'register']) {
  test(`${operation} returns to the same authorization after successful authentication`, async t => {
    t.mock.method(authApi, operation, async () => ({ ...account, accessToken: 'new-session' }))
    const node = await render(t, false)
    assert.ok(node.querySelector('#login-email'))
    if (operation === 'register') {
      await act(async () => auth.navigate('register'))
      assert.ok(node.querySelector('#reg-email'))
    }
    await act(async () => auth[operation]({ email: account.email, displayName: 'Alice', password: 'test-password' }))
    assert.equal(window.location.hash, hash)
    assert.equal(node.querySelector('h1')?.textContent, 'Sign in to Tokens Anywhere')
    assert.match(node.textContent, /Alice/)
  })
}
