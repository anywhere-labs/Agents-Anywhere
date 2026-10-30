import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const source = registerSource()
// Keep real inputs/buttons and screen validation; isolate authentication effects.
const mocks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/auth/auth-context.tsx')) return { format: 'module', shortCircuit: true, source: 'export const useAuth = () => globalThis.authFormFixture' }
    if (url.endsWith('/auth/auth-shell.tsx')) return { format: 'module', shortCircuit: true, source: 'export const AuthShell = ({children}) => children' }
    return next(url, context)
  },
})
const { LoginScreen } = await import('../src/components/auth/login-screen.tsx')
const { RegisterScreen } = await import('../src/components/auth/register-screen.tsx')
const { BootstrapScreen } = await import('../src/components/auth/bootstrap-screen.tsx')
const { ForgotPasswordScreen } = await import('../src/components/auth/forgot-password-screen.tsx')
const { OAuthNewUserScreen } = await import('../src/components/auth/oauth-new-user-screen.tsx')
mocks.deregister()
source.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))

async function render(t, Screen, overrides = {}) {
  const calls = []
  globalThis.authFormFixture = {
    loading: false, error: null, registrationOpen: true, passwordResetEnabled: true,
    oauthEnabled: true, oauthProviderLabel: 'OAuth', emailVerificationRequired: false,
    oauthPending: { status: 'needs_registration', email: 'member@example.test', displayName: 'Member', pendingToken: 'pending' },
    login: async credentials => { calls.push(credentials) }, register: async credentials => { calls.push(credentials) },
    finalizeOAuth: async credentials => { calls.push(credentials) }, navigate() {}, startOAuth() {}, cancelOAuth() {}, ...overrides,
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const update = () => act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(Screen))))
  await update()
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete globalThis.authFormFixture })
  return { container, calls, update }
}
async function fill(container, selector, value) {
  const input = container.querySelector(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('login identifies the saved credential pair and submits once via the form or button', async t => {
  const { container, calls, update } = await render(t, LoginScreen)
  const form = container.querySelector('form')
  const email = form.elements.namedItem('email')
  const password = form.elements.namedItem('password')
  assert.equal(email.autocomplete, 'username')
  assert.equal(email.type, 'email')
  assert.equal(email.inputMode, 'email')
  assert.equal(email.getAttribute('autocapitalize'), 'none')
  assert.equal(email.getAttribute('autocorrect'), 'off')
  assert.equal(password.autocomplete, 'current-password')
  assert.equal(form.querySelector('button[type="submit"]').disabled, true)
  await fill(container, '#login-email', 'member@example.test')
  await fill(container, '#login-password', 'synthetic password')
  await act(async () => form.requestSubmit())
  assert.deepEqual(calls, [{ email: 'member@example.test', password: 'synthetic password' }])
  await act(async () => form.querySelector('button[type="submit"]').click())
  assert.equal(calls.length, 2)
  await act(async () => form.querySelector('button[aria-label]').click())
  assert.equal(password.type, 'text')
  assert.equal(calls.length, 2)
  await act(async () => form.querySelector('button[type="button"][data-slot="button"]:not([aria-label])').click())
  assert.equal(calls.length, 2)
  globalThis.authFormFixture.loading = true
  await update()
  await act(async () => form.requestSubmit())
  assert.equal(calls.length, 2)
})

test('login rejects invalid email and empty password on direct form submission', async t => {
  const { container, calls } = await render(t, LoginScreen)
  await fill(container, '#login-email', 'not-an-email')
  await fill(container, '#login-password', 'synthetic password')
  await act(async () => container.querySelector('form').requestSubmit())
  assert.equal(calls.length, 0)
  await fill(container, '#login-email', 'member@example.test')
  await fill(container, '#login-password', '')
  await act(async () => container.querySelector('form').requestSubmit())
  assert.equal(calls.length, 0)
})

for (const [Screen, autocomplete] of [[RegisterScreen, 'email'], [BootstrapScreen, 'email'], [ForgotPasswordScreen, 'username'], [OAuthNewUserScreen, 'email']]) {
  test(`${Screen.name} exposes a credential form and keeps auxiliary buttons out of submission`, async t => {
    const { container, calls } = await render(t, Screen)
    const form = container.querySelector('form')
    assert.ok(form)
    assert.equal(form.elements.namedItem('email').autocomplete, autocomplete)
    assert.equal(form.querySelectorAll('button[type="submit"]').length, 1)
    assert.equal(form.querySelectorAll('button:not([type])').length, 0)
    for (const input of form.querySelectorAll('input[type="password"]')) {
      assert.ok(input.name)
      assert.equal(input.autocomplete, 'new-password')
    }
    // Empty or incomplete credentials cannot be submitted by bypassing the disabled button.
    await act(async () => form.requestSubmit())
    if (Screen !== OAuthNewUserScreen) assert.equal(calls.length, 0)
    else assert.equal(calls.length, 1) // OAuth-only registration needs no local password.
  })
}
