import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { transform } from 'lightningcss'
import { act, createElement, type ComponentType } from 'react'
import { Context } from '@deepseek-ai/cordis'
import type { DesktopDetection, OnboardingHostApi, OnboardingSnapshot } from '../src/contracts/index.ts'
import { DEFAULT_CONNECTOR_SETTINGS } from '../src/contracts/connector.ts'
import type { MobileLoginSnapshot } from '../src/contracts/mobile.ts'

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
  const ctx = new Context()
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
      document, setTimeout, clearTimeout, setInterval, clearInterval, crypto, Error, URL,
      HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
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
    const font = readFileSync(new URL('../src/client/assets/caveat-latin.woff2', import.meta.url))
    assert.ok(ownedStyles().some(style => style.textContent?.includes(`data:font/woff2;base64,${font.toString('base64')}`)),
      'The wordmark font must be embedded in the published factory without a static asset server')
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
      deviceRecovery: null,
      connector: { settings: { ...DEFAULT_CONNECTOR_SETTINGS }, resolvedUvPath: '/usr/local/bin/uv',
        dataPath: '/example/connector', logsPath: '/example/logs', canOpenFolders: true, deviceName: '本机', lastError: null },
    }
    let mobile: MobileLoginSnapshot = { id: 'qr-test', status: 'pending_scan', qrImage: 'data:image/png;base64,cXI=',
      expiresAt: new Date(Date.now() + 120_000).toISOString(), deviceName: null }
    const calls: { endpoint: string; payload: unknown }[] = []
    let failNextBegin = false
    let failInspect = false
    let inspectGate: Promise<void> | null = null
    let failLogout = false
    let failRecovery = false
    let failLogs = false
    let failOpenDesktop = false
    const reconfigurationUrl = 'http://127.0.0.1:5174/#/onboarding?source=dsh-plugin&connectorId=conn_reconfigured&flowId=4c7b8c71-134e-4495-a3ee-b704962414f9'
    type EntryProps = { host: OnboardingHostApi; wide: boolean }
    let entry: { Component: ComponentType<EntryProps>; props: { host: OnboardingHostApi } } | undefined
    let entryCount = 0
    ctx.provide('connection', { rpc: { call: async (channel: string, endpoint: string, payload: unknown) => {
        assert.equal(channel, '/api')
        calls.push({ endpoint, payload })
        if (endpoint.endsWith('/readBridgeLogs')) return failLogs ? { ok: false, error: { message: 'read failed' } } : {
          ok: true, value: { updatedAt: new Date().toISOString(), entries: [{ id: 'fixture-read-failure', outcome: 'failed', time: new Date().toISOString(),
            level: 'error', event: 'session.visibility_read.failed', details: '{"sessionId":"native-test","errorCode":"PERSISTENCE_ERROR"}' }] },
        }
        if (endpoint.endsWith('/inspect')) {
          const inspected = snapshot
          if (inspectGate) await inspectGate
          return failInspect ? { ok: false, error: { message: '读取状态失败。' } } : { ok: true, value: inspected }
        }
        if (endpoint.endsWith('/openDesktop')) {
          if (failOpenDesktop) return { ok: false, error: { message: '无法打开 Agents Anywhere 桌面端：spawn failed' } }
          return { ok: true, value: { flowId: 'abcdefghijklmnopqrstuvwx',
            url: 'agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=abcdefghijklmnopqrstuvwx' } }
        }
        if (endpoint.endsWith('/begin')) {
          if (failNextBegin) { failNextBegin = false; return { ok: false, error: { message: '无法连接服务器，请检查地址和网络后重试。' } } }
          snapshot = { ...snapshot, stage: 'authorizing' }
          return { ok: true, value: { url: 'https://example.com/onboarding' } }
        }
        if (endpoint.endsWith('/cancel')) snapshot = { ...snapshot, stage: 'idle' }
        if (endpoint.endsWith('/createMobileLogin')) return { ok: true, value: mobile }
        if (endpoint.endsWith('/inspectMobileLogin')) return { ok: true, value: mobile }
        if (endpoint.endsWith('/confirmMobileLogin')) {
          const args = (payload as { args: { approved: boolean } }).args
          mobile = { ...mobile, status: args.approved ? 'approved' : 'rejected', qrImage: null }
          return { ok: true, value: mobile }
        }
        if (endpoint.endsWith('/saveConnectorSettings')) {
          snapshot = { ...snapshot, connector: { ...snapshot.connector,
            settings: (payload as { args: { settings: OnboardingSnapshot['connector']['settings'] } }).args.settings } }
        }
        if (endpoint.endsWith('/controlConnector')) {
          snapshot = { ...snapshot, connectorRunning: (payload as { args: { action: string } }).args.action !== 'stop' }
        }
        if (endpoint.endsWith('/recoverDevice')) {
          if (failRecovery) return { ok: false, error: { message: '设备创建失败，请重试。' } }
          const action = (payload as { args: { action: string } }).args.action
          snapshot = { ...snapshot, deviceRecovery: null, stage: 'ready', connectorRunning: true,
            connectorId: action === 'recreate' ? 'conn_reconfigured' : snapshot.connectorId }
          return { ok: true, value: action === 'recreate' ? { url: reconfigurationUrl } : null }
        }
        if (endpoint.endsWith('/logout')) {
          if (failLogout) return { ok: false, error: { message: '退出失败，请重试。' } }
          snapshot = { ...snapshot, account: null, stage: 'idle', connectorRunning: false, connectorId: null, flowId: null }
        }
        return { ok: true, value: snapshot }
      } } })
    ctx.provide('slots', {
        inject(name: string, register: () => () => void) { assert.equal(name, 'sidebar.footer.action'); return register() },
        register(options: { name: string; id: string; label: () => string; inject: () => { host: OnboardingHostApi } }, Component: ComponentType<EntryProps>) {
          assert.equal(options.name, 'sidebar.footer.action', 'The entry belongs above Settings, not inside it')
          assert.equal(options.id, 'agents-anywhere-next')
          assert.equal(options.label(), '手机连接')
          entry = { Component, props: options.inject() }
          entryCount++
          return () => { entryCount-- }
        },
    })
    await ctx.plugin(client).await()
    assert.equal(entryCount, 1)
    assert.ok(entry)
    const { Component, props } = entry
    const container = document.querySelector('main')!
    const root = createRoot(container)
    unmount = () => root.unmount()
    await act(async () => { root.render(createElement(Component, { ...props, wide: true })) })
    const button = (text: string) => {
      const element = Array.from((dialog() ?? document).querySelectorAll('button')).find(item => item.textContent === text || item.getAttribute('aria-label') === text)
      assert.ok(element, `Missing button: ${text}`)
      return element
    }
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
    const trigger = button('手机连接')
    assert.equal(trigger.textContent, '手机连接')
    assert.ok(trigger.querySelector('svg.lucide-smartphone'))
    assert.equal(dialog(), null)
    assert.equal(calls.length, 0, 'A closed connection panel must not poll the Host')
    const listeners = new Set<() => void>()
    let current: string | null = 'native-selected'
    const selectionCalls = () => calls.filter(call => call.endpoint.endsWith('/selection')).map(call =>
      (call.payload as { args: { input: { clientId: string; revision: number; current: string | null } } }).args.input)
    ctx.provide('sessions', { list: {
      getSnapshot: () => ({ current }),
      subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback) } },
    } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(listeners.size, 1, 'The optional official sessions service must activate its scoped subscription')
    assert.equal(selectionCalls()[0]?.current, current)
    assert.equal(calls.filter(call => !call.endpoint.endsWith('/selection')).length, 0, 'Selection reporting must not require opening the connection panel')
    current = 'another-session'
    for (const listener of listeners) listener()
    assert.equal(selectionCalls().at(-1)?.current, current)
    assert.equal(selectionCalls().at(-1)?.revision, 2)
    assert.equal(selectionCalls()[0]?.clientId, selectionCalls().at(-1)?.clientId)
    await act(async () => { trigger.click() })
    assert.ok(dialog())
    assert.equal(dialog()!.getAttribute('aria-label'), 'Agents Anywhere')
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

    await act(async () => {
      button('去 GitHub 点 Star').focus()
      button('去 GitHub 点 Star').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
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
    assert.equal(dialog()!.getAttribute('aria-label'), 'Agents Anywhere', 'Login completion replaces the form without reopening the panel')
    const wordmark = dom.window.getComputedStyle(dialog()!.querySelector('h2')!)
    assert.match(wordmark.fontFamily, /AA Caveat/)
    assert.equal(wordmark.fontSize, '20px')
    assert.equal(wordmark.fontWeight, '500')
    assert.equal(dialog()!.querySelector('input'), null)
    assert.match(dialog()!.textContent!, /BensonWang/)
    assert.match(dialog()!.textContent!, /benson@example.test/)
    assert.match(dialog()!.textContent!, /Connector运行中/)
    assert.equal(dialog()!.querySelector('[data-state]')?.getAttribute('data-state'), 'done')
    assert.doesNotMatch(dialog()!.textContent!, /连接手机|继续设置|连接服务器|浏览器没有打开|登录 Agents Anywhere Cloud|OR/)
    assert.deepEqual(Array.from(dialog()!.querySelectorAll('button')).map(element => element.textContent).filter(Boolean), ['登录和连接', '设置', '运行日志', '打开 Web', '手机连接', '退出登录', '下载 Agents Anywhere 桌面端', '加入内测交流群', '去 GitHub 点 Star'])
    for (const [label, url] of [
      ['下载 Agents Anywhere 桌面端', 'https://www.agents-anywhere.com'],
      ['加入内测交流群', 'https://github.com/anywhere-labs/Agents-Anywhere#%E4%BA%A4%E6%B5%81%E4%B8%8E%E5%8F%8D%E9%A6%88'],
      ['去 GitHub 点 Star', 'https://github.com/anywhere-labs/Agents-Anywhere'],
    ]) {
      await act(async () => { button(label!).click() })
      assert.deepEqual(openedUrls.at(-1), { url, target: '_blank', features: 'noopener,noreferrer' })
    }
    const avatarImage = dialog()!.querySelector('img')!
    assert.equal(avatarImage.getAttribute('src'), avatar)
    await act(async () => { avatarImage.dispatchEvent(new dom.window.Event('error')) })
    assert.equal(dialog()!.querySelector('img'), null, 'Broken avatars fall back to the official user icon')
    assert.ok(dialog()!.querySelector('[aria-label="账号信息"] svg'))

    const beginsBeforeOpeningWeb = calls.filter(call => call.endpoint.endsWith('/begin')).length
    await act(async () => { button('打开 Web').click() })
    assert.equal(openedUrls.at(-1)?.url, snapshot.webAppUrl)
    assert.equal(calls.filter(call => call.endpoint.endsWith('/begin')).length, beginsBeforeOpeningWeb, 'Opening Web must not restart OAuth or pairing')

    await act(async () => { button('手机连接').click() })
    assert.equal(dialog()!.querySelector('img[alt="手机连接二维码"]')?.getAttribute('src'), mobile.qrImage)
    assert.ok(calls.some(call => call.endpoint.endsWith('/createMobileLogin')))
    assert.doesNotMatch(dialog()!.textContent!, /安装地址|下载手机端|App Store|Google Play/)
    mobile = { ...mobile, status: 'pending_web_confirm', deviceName: 'Test Phone', qrImage: null }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_700)) })
    assert.match(dialog()!.textContent!, /Test Phone请求连接此账号/)
    assert.equal(dialog()!.querySelector('img[alt="手机连接二维码"]'), null)
    await act(async () => { button('确认连接').click() })
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.endpoint.endsWith('/confirmMobileLogin')).at(-1)?.payload)), {
      args: { id: 'qr-test', approved: true },
    })
    mobile = { ...mobile, status: 'consumed' }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_700)) })
    assert.match(dialog()!.textContent!, /手机已连接/)
    await act(async () => { button('收起二维码').click() })

    await act(async () => { button('设置').click() })
    assert.equal(button('设置').getAttribute('aria-selected'), 'true')
    assert.equal(dialog()!.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'), button('设置').id)
    assert.match(dialog()!.textContent!, /Connector IDconn_test/)
    assert.doesNotMatch(dialog()!.textContent!, /随插件启动|高级参数|心跳间隔|重连间隔|连接时同步已有会话|重置本机连接|数据：|日志：/)
    assert.ok(!dialog()!.textContent!.includes(snapshot.connector.dataPath))
    assert.ok(!dialog()!.textContent!.includes(snapshot.connector.logsPath))
    assert.equal(button('恢复出厂设置').parentElement, button('打开数据目录').parentElement)
    assert.equal(button('恢复出厂设置').parentElement, button('打开日志目录').parentElement)
    assert.equal(button('保存并重启').disabled, true)
    await act(async () => { button('PyPI 镜像').click() })
    const mirror = Array.from(dialog()!.querySelectorAll('[role="menuitem"]')).find(item => item.textContent?.includes('清华大学')) as HTMLElement | undefined
    assert.ok(mirror)
    await act(async () => { mirror.click() })
    await act(async () => { button('保存并重启').click() })
    const savedSettings = (calls.find(call => call.endpoint.endsWith('/saveConnectorSettings'))?.payload as { args: { settings: { uvPypiIndexUrl: string } } }).args.settings
    assert.equal(savedSettings.uvPypiIndexUrl, 'https://pypi.tuna.tsinghua.edu.cn/simple')
    assert.match(dialog()!.textContent!, /设置已保存/)
    await act(async () => { button('停止 Connector').click() })
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.endpoint.endsWith('/controlConnector')).at(-1)?.payload)), { args: { action: 'stop' } })
    assert.ok(button('启动 Connector'))
    await act(async () => { button('启动 Connector').click() })
    assert.ok(button('重启 Connector'))
    await act(async () => { button('打开日志目录').click() })
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.endpoint.endsWith('/openConnectorFolder')).at(-1)?.payload)), { args: { folder: 'logs' } })
    await act(async () => { button('恢复出厂设置').focus(); button('恢复出厂设置').click() })
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2)
    assert.equal(dialog()!.hasAttribute('inert'), true, 'The parent dialog must be inert while confirming a reset')
    assert.equal(calls.some(call => call.endpoint.endsWith('/resetConnector')), false, 'Opening confirmation must never reset the device')
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'Escape closes only the reset confirmation')
    assert.equal(dialog()!.hasAttribute('inert'), false)
    assert.equal(document.activeElement, button('恢复出厂设置'))
    await act(async () => {
      button('设置').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    assert.equal(button('登录和连接').getAttribute('aria-selected'), 'true')
    assert.equal(document.activeElement, button('登录和连接'))

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
    for (const [status, label, action, message] of [
      ['deleted', '重新配置', 'recreate', '本机设备已被删除，请重新配置以恢复连接。'],
      ['disconnected', '重新连接', 'reconnect', '本机设备已断开连接，是否重新连接？'],
      ['unavailable', '重新检查', 'check', '暂时无法确认设备状态，请检查网络后重试。'],
    ] as const) {
      snapshot = { ...snapshot, stage: 'error', connectorRunning: false, deviceRecovery: { connectorId: 'conn_test', status, message } }
      await reopen()
      assert.ok(button(label).closest('[role="status"]'), 'Recovery action belongs inside the Connector status area')
      assert.ok(dialog()!.textContent!.includes(message))
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
      const openedBeforeRecovery = openedUrls.length
      await act(async () => { button(label).click(); button(label).click() })
      assert.equal(openedUrls.length, openedBeforeRecovery + (action === 'recreate' ? 1 : 0))
      if (action === 'recreate') {
        assert.equal(openedUrls.at(-1)?.url, reconfigurationUrl)
        assert.equal(dialog()!.querySelector<HTMLAnchorElement>('a[href*="onboarding?"]')?.href, reconfigurationUrl)
        assert.match(dialog()!.textContent!, /点击继续配置/)
        assert.doesNotMatch(dialog()!.textContent!, /重新创建/)
      }
      assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.endpoint.endsWith('/recoverDevice')).at(-1)?.payload)), { args: { action } })
      assert.match(dialog()!.textContent!, /Connector运行中/)
      assert.equal(button('退出登录').disabled, false)
    }
    snapshot = { ...snapshot, stage: 'error', connectorRunning: false, deviceRecovery: {
      connectorId: 'conn_test', status: 'deleted', message: '本机设备已被删除，请重新配置以恢复连接。',
    } }
    failRecovery = true
    await reopen()
    const openedBeforeFailure = openedUrls.length
    await act(async () => { button('重新配置').click() })
    assert.equal(openedUrls.length, openedBeforeFailure)
    assert.match(dialog()!.textContent!, /设备创建失败/)
    assert.equal(button('重新配置').disabled, false)
    failRecovery = false
    snapshot = { ...snapshot, stage: 'ready', deviceRecovery: null, connectorRunning: false }
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
    assert.match(dialog()!.textContent!, /读取状态失败/)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang|打开 Web|退出登录|登录 Agents Anywhere Cloud/)
    assert.ok(button('重新检查'))
    // Diagnostics must stay accessible when installation/ownership inspection fails.
    await act(async () => { button('运行日志').click() })
    assert.match(dialog()!.textContent!, /session.visibility_read.failed/)
    assert.match(dialog()!.textContent!, /native-test/)
    assert.equal(dialog()!.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'), button('运行日志').id)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang|benson@example/)
    await act(async () => { button('暂停刷新').click() })
    const pausedReads = calls.filter(call => call.endpoint.endsWith('/readBridgeLogs')).length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
    assert.equal(calls.filter(call => call.endpoint.endsWith('/readBridgeLogs')).length, pausedReads)
    failLogs = true
    await act(async () => { button('刷新').click() })
    assert.match(dialog()!.textContent!, /运行日志读取失败/)
    assert.match(dialog()!.textContent!, /native-test/, 'Failed refresh keeps the last successful logs')
    failLogs = false
    await act(async () => { button('刷新').click(); button('继续刷新').click() })
    const resumedReads = calls.filter(call => call.endpoint.endsWith('/readBridgeLogs')).length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
    assert.ok(calls.filter(call => call.endpoint.endsWith('/readBridgeLogs')).length > resumedReads)
    failInspect = false
    await reopen()

    const signedInSnapshot = snapshot
    const installed: DesktopDetection = { status: 'installed', executablePath: '/example/Electron', launchArgs: [], packaged: false, message: 'installed' }
    const actionsBeforeDesktop = calls.filter(call => /\/(begin|logout|cancel)$/.test(call.endpoint)).length
    for (const account of [signedInSnapshot.account, null]) {
      snapshot = { ...signedInSnapshot, account, desktop: installed }
      const readsBefore = calls.filter(call => call.endpoint.endsWith('/inspect')).length
      await reopen()
      assert.ok(calls.filter(call => call.endpoint.endsWith('/inspect')).length > readsBefore, 'Every opening must perform a fresh detection')
      assert.equal(dialog()!.getAttribute('aria-label'), '手机连接')
      assert.match(dialog()!.textContent!, /已安装 Agents Anywhere 桌面端。请打开桌面端完成连接设置。/)
      assert.equal(dialog()!.querySelector('input, img, form, a'), null)
      assert.doesNotMatch(dialog()!.textContent!, /BensonWang|账号信息|Connector|打开 Web|退出登录|登录 Agents Anywhere Cloud/)
      assert.equal(dialog()!.querySelectorAll('button').length, 8, 'Desktop handoff keeps the open action and bridge diagnostics')
    }
    const openBefore = calls.filter(call => call.endpoint.endsWith('/openDesktop')).length
    await act(async () => { button('打开 Agents Anywhere').click() })
    assert.equal(calls.filter(call => call.endpoint.endsWith('/openDesktop')).length, openBefore + 1)
    failOpenDesktop = true
    await act(async () => { button('打开 Agents Anywhere').click() })
    assert.match(dialog()!.textContent!, /无法打开 Agents Anywhere 桌面端/)
    failOpenDesktop = false
    assert.equal(calls.filter(call => /\/(begin|logout|cancel)$/.test(call.endpoint)).length, actionsBeforeDesktop)

    snapshot = signedInSnapshot
    await reopen()
    assert.match(dialog()!.textContent!, /BensonWang/)
    let releaseInspection!: () => void
    inspectGate = new Promise(resolve => { releaseInspection = resolve })
    snapshot = { ...signedInSnapshot, desktop: installed }
    await reopen()
    assert.match(dialog()!.textContent!, /正在检查连接方式/)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang|登录 Agents Anywhere Cloud|已安装桌面端/)
    await act(async () => { releaseInspection() })
    inspectGate = null
    assert.match(dialog()!.textContent!, /已安装 Agents Anywhere 桌面端/)

    // A response from an earlier, closed opening must not overwrite the current mode.
    inspectGate = new Promise(resolve => { releaseInspection = resolve })
    snapshot = signedInSnapshot
    await reopen()
    assert.match(dialog()!.textContent!, /正在检查连接方式/)
    inspectGate = null
    snapshot = { ...signedInSnapshot, desktop: installed }
    await reopen()
    await act(async () => { releaseInspection() })
    assert.match(dialog()!.textContent!, /已安装 Agents Anywhere 桌面端/)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang/)

    snapshot = { ...signedInSnapshot, desktop: { status: 'error', message: '安装记录无法读取。' } }
    await reopen()
    assert.match(dialog()!.textContent!, /安装记录无法读取/)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang|打开 Web|退出登录/)
    snapshot = signedInSnapshot
    await act(async () => { button('重新检查').click() })
    assert.equal(dialog()!.getAttribute('aria-label'), 'Agents Anywhere')

    failLogout = true
    await act(async () => { button('退出登录').click() })
    assert.equal(dialog()!.getAttribute('aria-label'), 'Agents Anywhere')
    assert.match(dialog()!.querySelector('[role="alert"]')!.textContent!, /退出失败/)
    failLogout = false
    await act(async () => { button('退出登录').click() })
    assert.equal(dialog()!.getAttribute('aria-label'), 'Agents Anywhere')
    assert.equal(button('登录 Agents Anywhere Cloud').disabled, false)
    assert.doesNotMatch(dialog()!.textContent!, /BensonWang|benson@example.test|退出登录/)

    await act(async () => { unmount!(); unmount = undefined })
    await ctx.fiber.dispose()
    assert.equal(listeners.size, 0, 'Client unload must unsubscribe from selection changes')
    assert.equal(selectionCalls().at(-1)?.current, null, 'Client unload must release its selected-session presence')
    assert.equal(entryCount, 0, 'Client unload must remove its sidebar entry')
    assert.equal(dialog(), null, 'Client unload must remove an open dialog')
    assert.equal(container.hasAttribute('inert'), false, 'Client unload must restore the application root')
  } finally {
    if (unmount) await act(async () => unmount!())
    await ctx.fiber.dispose()
    hooks.deregister()
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}
