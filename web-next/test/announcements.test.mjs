import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter', 'Event', 'StorageEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AnnouncementGate } = await import('../src/components/announcements/announcement-gate.tsx')
const { ServiceAnnouncementCard } = await import('../src/components/pages/service-announcement-card.tsx')
const { announcementsApi } = await import('../src/features/announcements/api.ts')
const { ANNOUNCEMENT_READ_KEY, isAnnouncementUnread, markAnnouncementRead, readAnnouncementTimestamp } = await import('../src/features/announcements/read-state.ts')
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
let revision = Date.parse('2026-09-12T00:00:00.000Z')
function publication(markdown = '## 服务更新\n\n**已经完成**') {
  revision += 1000
  return { markdown, publishedAt: new Date(revision).toISOString() }
}
async function render(t, element) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async next => {
    await act(async () => root.render(h(NextIntlClientProvider, { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' }, next)))
  }
  await update(element)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { container, update }
}
async function click(element) { await act(async () => element.click()) }
function button(text) { return [...document.querySelectorAll('button')].find(item => item.textContent === text) }

test('announcement is shown once across login, registration and home, then reappears for a new publication', async t => {
  let current = publication()
  const get = t.mock.method(announcementsApi, 'current', async () => ({ announcement: current }))
  const { update } = await render(t, h(AnnouncementGate, { page: 'login' }))
  assert.match(document.querySelector('[role="dialog"]').textContent, /服务更新/)
  assert.equal(document.querySelector('[role="dialog"] strong').textContent, '已经完成')
  await click(button('我知道了'))
  assert.equal(window.localStorage.getItem(ANNOUNCEMENT_READ_KEY), current.publishedAt)
  await update(h(AnnouncementGate, { page: 'register' }))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  current = publication('新公告')
  await update(h(AnnouncementGate, { page: 'app' }))
  assert.match(document.querySelector('[role="dialog"]').textContent, /新公告/)
  assert.equal(get.mock.callCount(), 3)
})

test('hidden announcements, unsupported pages and failed requests do not show a modal', async t => {
  const get = t.mock.method(announcementsApi, 'current', async () => ({ announcement: null }))
  const { update } = await render(t, h(AnnouncementGate, { page: 'preview' }))
  assert.equal(get.mock.callCount(), 0)
  await update(h(AnnouncementGate, { page: 'login' }))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  get.mock.mockImplementation(async () => { throw new Error('offline') })
  await update(h(AnnouncementGate, { page: 'register' }))
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('a response from a previous page cannot replace the newest announcement', async t => {
  let finishOld
  const old = publication('old response')
  const latest = publication('latest response')
  let calls = 0
  t.mock.method(announcementsApi, 'current', async () => {
    if (++calls === 1) return new Promise(resolve => { finishOld = resolve })
    return { announcement: latest }
  })
  const { update } = await render(t, h(AnnouncementGate, { page: 'login' }))
  await update(h(AnnouncementGate, { page: 'app' }))
  await act(async () => finishOld({ announcement: old }))
  assert.match(document.querySelector('[role="dialog"]').textContent, /latest response/)
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /old response/)
})

test('read markers compare server publication times and never move backwards', () => {
  const old = publication()
  const newer = publication()
  assert.equal(isAnnouncementUnread(old, 'corrupt'), true)
  assert.equal(isAnnouncementUnread(old, old.publishedAt), false)
  assert.equal(isAnnouncementUnread(old, newer.publishedAt), false)
  assert.equal(isAnnouncementUnread({ markdown: '  ', publishedAt: newer.publishedAt }, null), false)
  assert.equal(isAnnouncementUnread({ markdown: 'hi', publishedAt: 'bad timestamp' }, null), false)
  markAnnouncementRead(newer.publishedAt)
  markAnnouncementRead(old.publishedAt)
  assert.equal(readAnnouncementTimestamp(), newer.publishedAt)
})

test('storage failures keep the current tab read marker without breaking dismissal', async t => {
  const current = publication()
  t.mock.method(announcementsApi, 'current', async () => ({ announcement: current }))
  t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('denied') })
  const { update } = await render(t, h(AnnouncementGate, { page: 'login' }))
  await click(button('我知道了'))
  await update(h(AnnouncementGate, { page: 'app' }))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(readAnnouncementTimestamp(), current.publishedAt)
})

test('Markdown HTML and unsafe links do not become executable elements', async t => {
  const current = publication('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n**Safe**')
  t.mock.method(announcementsApi, 'current', async () => ({ announcement: current }))
  await render(t, h(AnnouncementGate, { page: 'login' }))
  const dialog = document.querySelector('[role="dialog"]')
  assert.equal(dialog.querySelector('script'), null)
  assert.equal(dialog.querySelector('a[href^="javascript:"]'), null)
  assert.equal(dialog.querySelector('strong').textContent, 'Safe')
})

test('admin edits, previews and publishes Markdown, with empty enabled content rejected in the form', async t => {
  t.mock.method(announcementsApi, 'settings', async () => ({ enabled: false, markdown: '', publishedAt: null }))
  const save = t.mock.method(announcementsApi, 'save', async (_token, body) => ({ ...body, publishedAt: publication().publishedAt }))
  await render(t, h(ServiceAnnouncementCard, { token: 'admin-token' }))
  await click(document.querySelector('[role="switch"]'))
  assert.equal(button('保存公告').disabled, true)
  const textarea = document.querySelector('textarea')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '## 公告预览')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.match(document.body.textContent, /公告预览/)
  assert.equal(button('保存公告').disabled, false)
  await click(button('保存公告'))
  assert.deepEqual(save.mock.calls[0].arguments, ['admin-token', { enabled: true, markdown: '## 公告预览' }])
  assert.equal(button('保存公告').disabled, true)
})
