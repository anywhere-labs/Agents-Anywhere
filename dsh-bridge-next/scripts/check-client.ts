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
  const dom = new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>', { url: 'http://localhost' })
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
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: (registration: typeof registrations[number]) => registrations.push(registration) }, open: () => null },
      document, setTimeout, clearTimeout, Error,
    }, { timeout: 1_000 })
    assert.equal(registrations.length, 1)
    const registration = registrations[0]!
    assert.equal(registration.id, packageId)
    const client = registration.factory(require)
    assert.deepEqual(Array.from(client.inject), ['slots', 'connection'])

    const ownedStyles = () => Array.from(document.querySelectorAll('style')).filter(style => style.dataset.plugin === packageId)
    assert.equal(ownedStyles().length, 1, 'Client factory must install its scoped stylesheet')
    assert.match(ownedStyles()[0]!.textContent!, /--dsw-alias-label-primary/)
    registration.factory(require)
    assert.equal(ownedStyles().length, 1, 'Re-evaluating the factory must not duplicate styles')
    const foreignStyle = document.createElement('style')
    foreignStyle.dataset.plugin = 'another-plugin'
    document.head.appendChild(foreignStyle)
    for (const style of ownedStyles()) style.remove()
    registration.factory(require)
    assert.equal(ownedStyles().length, 1, 'Factory must restore its stylesheet after DSH HMR cleanup')
    assert.ok(foreignStyle.isConnected)

    let snapshot: OnboardingSnapshot = {
      desktop: { status: 'absent', message: '未找到 Desktop 安装记录。' },
      settings: { apiBaseUrl: 'http://127.0.0.1:8000', webBaseUrl: 'http://127.0.0.1:5174' },
      stage: 'idle', message: '登录后连接这台电脑。', account: null,
      connectorId: null, connectorRunning: false, flowId: null,
    }
    const calls: { endpoint: string; payload: unknown }[] = []
    let section: { Component: ComponentType<{ host: OnboardingHostApi }>; props: { host: OnboardingHostApi } } | undefined
    let settingsCount = 0
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
        inject(name: string, register: () => () => void) { assert.equal(name, 'settings.section'); return register() },
        register(options: { id: string; inject: () => { host: OnboardingHostApi } }, Component: ComponentType<{ host: OnboardingHostApi }>) {
          assert.equal(options.id, 'agents-anywhere-next')
          section = { Component, props: options.inject() }
          settingsCount++
          return () => { settingsCount-- }
        },
      },
    })
    assert.equal(settingsCount, 1)
    assert.ok(section)
    const { Component, props } = section
    const container = document.querySelector('main')!
    const root = createRoot(container)
    unmount = () => root.unmount()
    await act(async () => { root.render(createElement(Component, props)) })
    const button = (text: string) => {
      const element = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)
      assert.ok(element, `Missing button: ${text}`)
      return element
    }
    assert.equal(button('在浏览器中登录').disabled, false)
    await act(async () => { button('在浏览器中登录').click() })
    assert.ok(calls.some(call => call.endpoint === 'agentsAnywhereOnboarding/begin'))
    assert.equal(container.querySelector('a')?.href, 'https://example.com/onboarding')
    assert.equal(container.querySelector('[data-state]')?.getAttribute('data-state'), 'ongoing')
    await act(async () => { button('取消本次连接').click() })
    assert.ok(calls.some(call => call.endpoint === 'agentsAnywhereOnboarding/cancel'))
    assert.equal(container.querySelector('a'), null)

    const inputs = Array.from(container.querySelectorAll('input'))
    assert.equal(inputs.length, 2)
    assert.ok(inputs.every(input => input.required && input.type === 'url' && input.labels?.length === 1))
    assert.deepEqual(inputs.map(input => input.value), [snapshot.settings.webBaseUrl, snapshot.settings.apiBaseUrl])
    await act(async () => { container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) })
    const configure = calls.find(call => call.endpoint === 'agentsAnywhereOnboarding/configure')
    assert.ok(configure)
    assert.deepEqual(JSON.parse(JSON.stringify(configure.payload)), { args: { settings: snapshot.settings } })

    await act(async () => { unmount!(); unmount = undefined })
    for (const dispose of disposers.splice(0).reverse()) dispose()
    assert.equal(settingsCount, 0, 'Client unload must remove its settings section')
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
