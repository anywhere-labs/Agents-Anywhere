import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { transform } from 'lightningcss'
import { act, createElement, type ComponentType } from 'react'
import type { OnboardingHostApi, OnboardingSnapshot } from '../src/contracts/index.ts'

/** Exercise the published factory and real primitives without a browser or DSH process. */
export async function checkClient(source: string, packageId: string): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="root"></main></body></html>', { url: 'http://localhost' })
  const { document } = dom.window
  const globals = { window: dom.window, document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })

  // npm primitives contain CSS imports. Supply their real CSS Modules maps for
  // Node; the browser receives the official module from DSH's platform registry.
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith('.css')) return nextLoad(url, context)
      const filename = fileURLToPath(url)
      const result = transform({ filename, code: readFileSync(filename), cssModules: filename.endsWith('.module.css') })
      const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
      return { format: 'module', source: `export default ${JSON.stringify(classes)};`, shortCircuit: true }
    },
  })
  const disposers: (() => void)[] = []
  let unmount: (() => void) | undefined
  try {
    const { createRoot } = await import('react-dom/client')
    const require = createRequire(import.meta.url)
    type Client = { apply: (ctx: unknown) => void; inject: string[] }
    const registrations: { id: string; factory: (require: NodeRequire) => Client }[] = []
    const openedUrls: { url: string; target: string; features: string }[] = []
    runInNewContext(source, {
      window: {
        __ModuleLoader__: { load: (registration: typeof registrations[number]) => registrations.push(registration) },
        open: (url: string, target: string, features: string) => {
          openedUrls.push({ url, target, features })
          // Electron opens external HTTP(S) URLs and returns no renderer window.
          return null
        },
      },
      document, setTimeout, clearTimeout, Error,
    }, { timeout: 1_000 })
    assert.equal(registrations.length, 1)
    const registration = registrations[0]!
    assert.equal(registration.id, packageId)
    const client = registration.factory(require)
    assert.deepEqual(Array.from(client.inject), ['slots', 'connection'])

    const ownedStyles = () => Array.from(document.querySelectorAll('style')).filter(style => style.dataset.plugin === packageId)
    const styleCount = ownedStyles().length
    assert.ok(styleCount > 0, 'Client factory must install its scoped stylesheets')
    assert.ok(ownedStyles().some(style => style.textContent?.includes('--dsw-alias-label-primary')))
    registration.factory(require)
    assert.equal(ownedStyles().length, styleCount, 'Re-evaluating the factory must not duplicate styles')
    const foreignStyle = document.createElement('style')
    foreignStyle.dataset.plugin = 'another-plugin'
    document.head.appendChild(foreignStyle)
    for (const style of ownedStyles()) style.remove()
    registration.factory(require)
    assert.equal(ownedStyles().length, styleCount, 'Factory must restore its stylesheets after DSH HMR cleanup')
    assert.ok(foreignStyle.isConnected)

    let snapshot: OnboardingSnapshot = {
      desktop: { status: 'absent', message: '未找到 Desktop 安装记录。' },
      settings: { apiBaseUrl: 'http://127.0.0.1:8000', webBaseUrl: 'http://127.0.0.1:5174' },
      stage: 'idle', message: '登录后连接这台电脑。', account: null,
      connectorId: null, connectorRunning: false, flowId: null,
    }
    const calls: { endpoint: string; payload: unknown }[] = []
    type EntryProps = { host: OnboardingHostApi; wide: boolean }
    let entry: { Component: ComponentType<EntryProps>; props: { host: OnboardingHostApi } } | undefined
    let entryCount = 0
    client.apply({
      connection: { rpc: { call: async (channel: string, endpoint: string, payload: unknown) => {
        assert.equal(channel, '/api')
        calls.push({ endpoint, payload })
        if (endpoint.endsWith('/begin')) {
          snapshot = { ...snapshot, stage: 'authorizing' }
          return { ok: true, value: { url: 'https://example.com/onboarding' } }
        }
        if (endpoint.endsWith('/cancel')) snapshot = { ...snapshot, stage: 'idle' }
        return { ok: true, value: snapshot }
      } } },
      effect(effect: () => () => void) { disposers.push(effect()) },
      slots: {
        inject(name: string, register: () => () => void) { assert.equal(name, 'sidebar.footer.action'); return register() },
        register(options: { name: string; id: string; label: () => string; inject: () => { host: OnboardingHostApi } }, Component: ComponentType<EntryProps>) {
          assert.equal(options.name, 'sidebar.footer.action', 'The entry belongs above Settings, not inside it')
          assert.equal(options.id, 'agents-anywhere-next')
          assert.equal(options.label(), '插件连接')
          entry = { Component, props: options.inject() }
          entryCount++
          return () => { entryCount-- }
        },
      },
    })
    assert.equal(entryCount, 1)
    assert.ok(entry)
    const { Component, props } = entry
    const container = document.querySelector('main')!
    const root = createRoot(container)
    unmount = () => root.unmount()
    await act(async () => { root.render(createElement(Component, { ...props, wide: true })) })
    const button = (text: string) => {
      const element = Array.from(document.querySelectorAll('button')).find(item => item.textContent === text || item.getAttribute('aria-label') === text)
      assert.ok(element, `Missing button: ${text}`)
      return element
    }
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="插件连接"]')
    const trigger = button('插件连接')
    assert.equal(trigger.textContent, '插件连接')
    assert.ok(trigger.querySelector('svg.lucide-smartphone'))
    assert.equal(dialog(), null)
    assert.equal(calls.length, 0, 'A closed connection panel must not poll the Host')
    await act(async () => { trigger.click() })
    assert.ok(dialog())
    assert.equal(container.contains(dialog()), false, 'Official Modal must portal outside the sidebar')
    assert.equal(container.hasAttribute('inert'), true)
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, button('关闭插件连接'))
    assert.equal(button('在浏览器中登录').disabled, false)
    await act(async () => { button('在浏览器中登录').click() })
    assert.ok(calls.some(call => call.endpoint === 'agentsAnywhereOnboarding/begin'))
    assert.deepEqual(openedUrls, [{ url: 'https://example.com/onboarding', target: '_blank', features: 'noopener,noreferrer' }])
    assert.equal(dialog()!.querySelector('a')?.href, 'https://example.com/onboarding')
    assert.equal(dialog()!.querySelector('[data-state]')?.getAttribute('data-state'), 'ongoing')
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dialog(), null)
    assert.equal(container.hasAttribute('inert'), false)
    assert.equal(document.activeElement, trigger)
    assert.equal(calls.filter(call => /\/(cancel|logout)$/.test(call.endpoint)).length, 0, 'Closing the dialog must preserve the Host connection flow')
    await act(async () => { trigger.click() })
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    await act(async () => { button('取消本次连接').click() })
    assert.ok(calls.some(call => call.endpoint === 'agentsAnywhereOnboarding/cancel'))
    assert.equal(dialog()!.querySelector('a'), null)

    const inputs = Array.from(dialog()!.querySelectorAll('input'))
    assert.equal(inputs.length, 2)
    assert.ok(inputs.every(input => input.required && input.type === 'url' && input.labels?.length === 1))
    assert.deepEqual(inputs.map(input => input.value), [snapshot.settings.webBaseUrl, snapshot.settings.apiBaseUrl])
    await act(async () => {
      dialog()!.querySelector('details')!.open = true
      dialog()!.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    const configure = calls.find(call => call.endpoint === 'agentsAnywhereOnboarding/configure')
    assert.ok(configure)
    assert.deepEqual(JSON.parse(JSON.stringify(configure.payload)), { args: { settings: snapshot.settings } })

    const saveButton = button('保存连接地址')
    await act(async () => {
      saveButton.focus()
      saveButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    assert.equal(document.activeElement, button('关闭插件连接'))
    await act(async () => { button('关闭插件连接').click() })
    assert.equal(dialog(), null)
    await act(async () => { root.render(createElement(Component, { ...props, wide: false })) })
    assert.equal(trigger.textContent, '', 'Collapsed sidebar must keep only the icon and accessible name')
    assert.ok(trigger.querySelector('svg.lucide-smartphone'))
    await act(async () => { trigger.click() })
    await act(async () => { (dialog()!.parentElement!.firstElementChild as HTMLElement).click() })
    assert.equal(dialog(), null, 'Mask click must close the dialog')
    assert.equal(container.hasAttribute('inert'), false)
    await act(async () => { trigger.click() })

    await act(async () => { unmount!(); unmount = undefined })
    for (const dispose of disposers.splice(0).reverse()) dispose()
    assert.equal(entryCount, 0, 'Client unload must remove its sidebar entry')
    assert.equal(dialog(), null, 'Client unload must remove an open dialog')
    assert.equal(container.hasAttribute('inert'), false, 'Client unload must restore the application root')
  } finally {
    if (unmount) await act(async () => unmount!())
    for (const dispose of disposers.reverse()) dispose()
    hooks.deregister()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}
