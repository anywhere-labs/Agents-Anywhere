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
      document, setTimeout, clearTimeout, Error, URL,
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
      settings: { apiBaseUrl: 'http://127.0.0.1:8000' },
      webAppUrl: 'http://127.0.0.1:5174/#/',
      stage: 'idle', message: '登录后连接这台电脑。', account: null,
      connectorId: null, connectorRunning: false, flowId: null,
    }
    const calls: { endpoint: string; payload: unknown }[] = []
    let failNextBegin = false
    let failInspect = false
    let failLogout = false
    type EntryProps = { host: OnboardingHostApi; wide: boolean }
    let entry: { Component: ComponentType<EntryProps>; props: { host: OnboardingHostApi } } | undefined
    let entryCount = 0
    client.apply({
      connection: { rpc: { call: async (channel: string, endpoint: string, payload: unknown) => {
        assert.equal(channel, '/api')
        calls.push({ endpoint, payload })
        if (endpoint.endsWith('/inspect') && failInspect) return { ok: false, error: { message: '读取状态失败。' } }
        if (endpoint.endsWith('/begin')) {
          if (failNextBegin) { failNextBegin = false; return { ok: false, error: { message: '无法连接服务器，请检查地址和网络后重试。' } } }
          snapshot = { ...snapshot, stage: 'authorizing' }
          return { ok: true, value: { url: 'https://example.com/onboarding' } }
        }
        if (endpoint.endsWith('/cancel')) snapshot = { ...snapshot, stage: 'idle' }
        if (endpoint.endsWith('/logout')) {
          if (failLogout) return { ok: false, error: { message: '退出失败，请重试。' } }
          snapshot = { ...snapshot, account: null, stage: 'idle', connectorRunning: false, connectorId: null, flowId: null }
        }
        return { ok: true, value: snapshot }
      } } },
      effect(effect: () => () => void) { disposers.push(effect()) },
      slots: {
        inject(name: string, register: () => () => void) { assert.equal(name, 'sidebar.footer.action'); return register() },
        register(options: { name: string; id: string; label: () => string; inject: () => { host: OnboardingHostApi } }, Component: ComponentType<EntryProps>) {
          assert.equal(options.name, 'sidebar.footer.action', 'The entry belongs above Settings, not inside it')
          assert.equal(options.id, 'agents-anywhere-next')
          assert.equal(options.label(), '手机连接')
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
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
    const trigger = button('手机连接')
    assert.equal(trigger.textContent, '手机连接')
    assert.ok(trigger.querySelector('svg.lucide-smartphone'))
    assert.equal(dialog(), null)
    assert.equal(calls.length, 0, 'A closed connection panel must not poll the Host')
    await act(async () => { trigger.click() })
    assert.ok(dialog())
    assert.equal(dialog()!.getAttribute('aria-label'), '登录到 Agents Anywhere')
    assert.equal(container.contains(dialog()), false, 'Official Modal must portal outside the sidebar')
    assert.equal(container.hasAttribute('inert'), true)
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, button('关闭手机连接'))
    assert.match(dialog()!.textContent!, /在所有设备间访问你的 Agent、会话和工作空间。/)
    assert.equal(dialog()!.querySelector('input'), null, 'Server fields stay hidden until requested')
    assert.equal(button('登录 Agents Anywhere Cloud').disabled, false)
    await act(async () => { button('登录 Agents Anywhere Cloud').click() })
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.endpoint.endsWith('/begin'))?.payload)), { args: { input: { target: 'cloud' } } })
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

    await act(async () => { button('连接到你自己的 Agents Anywhere 服务实例').click() })
    const inputs = Array.from(dialog()!.querySelectorAll('input'))
    assert.equal(inputs.length, 1, 'Self-hosted login accepts only the backend address')
    const input = inputs[0]!
    assert.equal(input.labels?.[0]?.textContent, '连接到你自己的 Agents Anywhere 服务实例')
    assert.equal(input.placeholder, '输入服务器地址，例如 https://your-server.com')
    assert.equal(input.inputMode, 'url')
    assert.equal(document.activeElement, input)
    assert.equal(button('连接服务器').disabled, true)
    assert.ok(dialog()!.querySelector('svg.lucide-server'))
    const enterServer = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await enterServer('http://127.0.0.1:8000')
    assert.equal(button('连接服务器').disabled, false)
    await act(async () => {
      dialog()!.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.endpoint.endsWith('/begin')).at(-1)?.payload)), {
      args: { input: { target: 'server', serverUrl: 'http://127.0.0.1:8000' } },
    })
    assert.equal(calls.some(call => call.endpoint.endsWith('/configure')), false, 'Connecting must initiate login, not just save a form')
    assert.match(dialog()!.textContent!, /已打开登录页面，完成登录后将自动返回。/)
    await act(async () => { button('取消本次连接').click() })

    failNextBegin = true
    await act(async () => { button('连接服务器').click() })
    assert.equal(input.getAttribute('aria-invalid'), 'true')
    assert.match(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent!, /无法连接服务器/)
    await enterServer('https://another.example')
    assert.equal(input.getAttribute('aria-invalid'), 'false')
    await act(async () => { button('登录 Agents Anywhere Cloud').click() })
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.endpoint.endsWith('/begin')).at(-1)?.payload)), { args: { input: { target: 'cloud' } } })
    await act(async () => { button('取消本次连接').click() })

    const connectButton = button('连接服务器')
    await act(async () => {
      connectButton.focus()
      connectButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    assert.equal(document.activeElement, button('关闭手机连接'))
    await act(async () => { button('关闭手机连接').click() })
    assert.equal(dialog(), null)
    await act(async () => { root.render(createElement(Component, { ...props, wide: false })) })
    assert.equal(trigger.textContent, '', 'Collapsed sidebar must keep only the icon and accessible name')
    assert.ok(trigger.querySelector('svg.lucide-smartphone'))
    await act(async () => { trigger.click() })
    await act(async () => { (dialog()!.parentElement!.firstElementChild as HTMLElement).click() })
    assert.equal(dialog(), null, 'Mask click must close the dialog')
    assert.equal(container.hasAttribute('inert'), false)
    await act(async () => { trigger.click() })

    const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII='
    snapshot = {
      ...snapshot, stage: 'ready', connectorRunning: true, connectorId: 'conn_test',
      account: { userId: 'user-test', displayName: 'BensonWang', email: 'benson@example.test', avatar },
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_600)) })
    assert.equal(dialog()!.getAttribute('aria-label'), '已登录', 'Login completion replaces the entire form without reopening the panel')
    assert.equal(dialog()!.querySelector('input'), null)
    assert.match(dialog()!.textContent!, /BensonWang/)
    assert.match(dialog()!.textContent!, /benson@example.test/)
    assert.match(dialog()!.textContent!, /Connector运行中/)
    assert.equal(dialog()!.querySelector('[data-state]')?.getAttribute('data-state'), 'done')
    assert.doesNotMatch(dialog()!.textContent!, /连接手机|继续设置|连接服务器|浏览器没有打开|登录 Agents Anywhere Cloud|OR/)
    assert.deepEqual(Array.from(dialog()!.querySelectorAll('button')).map(element => element.textContent).filter(Boolean), ['打开 Web', '退出登录'])
    const avatarImage = dialog()!.querySelector('img')!
    assert.equal(avatarImage.getAttribute('src'), avatar)
    await act(async () => { avatarImage.dispatchEvent(new dom.window.Event('error')) })
    assert.equal(dialog()!.querySelector('img'), null, 'Broken avatars fall back to the official user icon')
    assert.ok(dialog()!.querySelector('[aria-label="账号信息"] svg'))

    const beginsBeforeOpeningWeb = calls.filter(call => call.endpoint.endsWith('/begin')).length
    await act(async () => { button('打开 Web').click() })
    assert.equal(openedUrls.at(-1)?.url, snapshot.webAppUrl)
    assert.equal(calls.filter(call => call.endpoint.endsWith('/begin')).length, beginsBeforeOpeningWeb, 'Opening Web must not restart OAuth or pairing')

    // An older Host lacks webAppUrl while the linked Client has already hot-reloaded.
    const { webAppUrl: _webAppUrl, ...legacySnapshot } = snapshot
    snapshot = legacySnapshot as OnboardingSnapshot
    await act(async () => { button('关闭手机连接').click() })
    await act(async () => { trigger.click() })
    assert.equal(button('打开 Web').disabled, false)
    await act(async () => { button('打开 Web').click() })
    assert.equal(openedUrls.at(-1)?.url, 'http://127.0.0.1:5174/#/')
    snapshot = { ...snapshot, webAppUrl: _webAppUrl }

    const reopen = async () => {
      await act(async () => { button('关闭手机连接').click() })
      await act(async () => { trigger.click() })
    }
    snapshot = { ...snapshot, connectorRunning: false }
    await reopen()
    assert.match(dialog()!.textContent!, /Connector未运行/)
    assert.equal(dialog()!.querySelector('[data-state]')?.getAttribute('data-state'), 'warning')
    snapshot = { ...snapshot, stage: 'starting', message: '正在准备运行环境…' }
    await reopen()
    assert.match(dialog()!.textContent!, /Connector正在启动/)
    snapshot = { ...snapshot, stage: 'error', message: 'Connector 意外退出。' }
    await reopen()
    assert.match(dialog()!.textContent!, /Connector运行异常/)
    assert.equal(dialog()!.querySelector('[data-state]')?.getAttribute('data-state'), 'error')
    failInspect = true
    await reopen()
    assert.match(dialog()!.textContent!, /状态暂不可用/)
    failInspect = false
    await reopen()

    failLogout = true
    await act(async () => { button('退出登录').click() })
    assert.equal(dialog()!.getAttribute('aria-label'), '已登录')
    assert.match(dialog()!.querySelector('[role="alert"]')!.textContent!, /退出失败/)
    failLogout = false
    await act(async () => { button('退出登录').click() })
    assert.equal(dialog()!.getAttribute('aria-label'), '登录到 Agents Anywhere')
    assert.equal(button('登录 Agents Anywhere Cloud').disabled, false)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang|benson@example.test|退出登录/)

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
