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
const { RegisterScreen } = await import('../src/components/auth/register-screen.tsx')
const { PrivacyPolicyScreen } = await import('../src/components/pages/privacy-policy-screen.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
hooks.deregister()

const messagesFor = locale => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'))

async function render(t, children, { locale = 'zh-CN' } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale, messages: messagesFor(locale), timeZone: 'Asia/Shanghai' }, children)))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return container
}

async function until(check) {
  for (let count = 0; count < 100; count++) {
    if (check()) return
    await act(async () => { await delay(10) })
  }
  assert.fail('Expected UI state did not arrive: ' + document.body.textContent)
}

test('privacy policy renders every section for both locales', async (t) => {
  const zh = await render(t, h(PrivacyPolicyScreen))
  const messages = messagesFor('zh-CN').privacy
  assert.equal(zh.querySelector('h1').textContent, messages.title)
  assert.match(zh.textContent, new RegExp(messages.updated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(zh.textContent, new RegExp(messages.introduction.slice(0, 12)))
  for (const section of Object.values(messages.sections)) {
    assert.match(zh.textContent, new RegExp(section.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing section: ${section.title}`)
    assert.ok(zh.textContent.includes(section.body.slice(0, 16)), `missing body: ${section.title}`)
  }
  assert.ok([...zh.querySelectorAll('button')].some(button => button.textContent === messages.back))

  const en = await render(t, h(PrivacyPolicyScreen), { locale: 'en' })
  assert.equal(en.querySelector('h1').textContent, messagesFor('en').privacy.title)
})

test('login and registration link to the standalone policy page', async (t) => {
  t.mock.method(authApi, 'config', async () => ({ needsBootstrap: false, registrationOpen: true }))
  t.mock.method(authApi, 'me', async () => null)
  const login = await render(t, h(AuthProvider, null, h(LoginScreen)))
  await until(() => login.querySelector('a[href="/privacy"]'))
  assert.equal(login.querySelector('a[href="/privacy"]').textContent, messagesFor('zh-CN').privacy.title)
  assert.match(login.textContent, new RegExp(messagesFor('zh-CN').auth.login.privacyNotice))

  const register = await render(t, h(AuthProvider, null, h(RegisterScreen)))
  await until(() => register.querySelector('a[href="/privacy"]'))
  assert.equal(register.querySelector('a[href="/privacy"]').textContent, messagesFor('zh-CN').privacy.title)
  assert.match(register.textContent, new RegExp(messagesFor('zh-CN').auth.register.privacyNotice))
})
