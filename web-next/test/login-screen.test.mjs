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
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AuthProvider } = await import('../src/components/auth/auth-context.tsx')
const { LoginScreen } = await import('../src/components/auth/login-screen.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
hooks.deregister()

const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))

async function until(check) {
  for (let count = 0; count < 100; count++) {
    if (check()) return
    await act(async () => { await delay(10) })
  }
  assert.fail('Expected UI state did not arrive: ' + document.body.textContent)
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('login asks for an email and blocks submission until the address is valid', async (t) => {
  t.mock.method(authApi, 'config', async () => ({ needsBootstrap: false, registrationOpen: true }))
  t.mock.method(authApi, 'me', async () => null)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, h(AuthProvider, null, h(LoginScreen)))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })

  await until(() => container.querySelector('#login-email'))
  const email = container.querySelector('#login-email')
  const submit = [...container.querySelectorAll('button')].find(button => button.textContent === messages.auth.login.submitWithEnter)
  const hint = messages.auth.login.invalidEmail
  await type(container.querySelector('#login-password'), 'secret')
  assert.ok(!container.textContent.includes(hint), 'an empty field shows no error')

  await type(email, 'not-an-email')
  assert.ok(container.textContent.includes(hint))
  assert.equal(email.getAttribute('aria-invalid'), 'true')
  assert.equal(email.getAttribute('aria-describedby'), 'login-email-error')
  assert.equal(submit.disabled, true)

  await type(email, 'user@example.com')
  assert.ok(!container.textContent.includes(hint))
  assert.equal(email.getAttribute('aria-invalid'), 'false')
  assert.equal(submit.disabled, false)
})
