import { Context } from '@deepseek-ai/cordis'
import { loadTestLocale, localeEntry } from '../../scripts/test-locale.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import type { RuntimeLogEntry, RuntimeLogQuery } from '../../src/contracts/logs.js'

test('published client shows unified interleaved runtime logs, source filters, cursor pagination, and explicit pre-startup diagnostics boundary', async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { runScripts: 'outside-only', url: 'https://test.invalid' })
  const values: Record<string, unknown> = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let entry: React.ComponentType<any> | undefined
  let client: any
  let locale: ReturnType<typeof loadTestLocale>
  const ctx = new Context()
  let bridge = { state: 'failed', message: '本机连接被占用，无法启动。', hint: '请退出其他正在运行的 DSH，再点击“尝试重启”。', canRetry: true }
  let restarts = 0
  let logsAvailable = true
  let runtimeLogs: RuntimeLogEntry[] = [
    {
      seq: 1,
      time: '2026-09-10T10:00:00Z',
      source: 'plugin',
      level: 'info',
      name: 'dsh-plugin',
      message: 'onboarding.started',
      details: '{"target":"cloud"}',
      exception: null,
    },
    {
      seq: 2,
      time: '2026-09-10T10:00:01Z',
      source: 'bridge',
      level: 'error',
      name: 'dsh-bridge',
      message: 'rpc.failed',
      method: 'getSessionState',
      outcome: 'failure',
      details: '{"errorCode":"TEST_ERROR"}',
      exception: null,
    },
    {
      seq: 3,
      time: '2026-09-10T10:00:02Z',
      source: 'connector',
      level: 'warn',
      name: 'connector.runtime',
      message: 'runtime heartbeat delayed',
      details: null,
      exception: 'Traceback: timeout',
    },
  ]
  const primitives = {
    Button: ({ children, icon, variant: _variant, ...props }: any) => React.createElement('button', props, icon, children),
    Tooltip: ({ children }: any) => children,
    Modal: ({ open, children }: any) => open ? createPortal(React.createElement('div', { role: 'dialog' }, children), document.body) : null,
  }
  ;(dom.window as any).__ModuleLoader__ = { load: ({ factory }: any) => { client = factory((name: string) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsx
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`Unexpected client import: ${name}`)
  }) } }
  const terminal = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, time: '2026-09-10T10:00:00Z', text: `terminal line ${i + 1}` }))
  const host = {
    inspect: async () => ({ desktop: { status: 'installed' }, bridge }),
    restartBridge: async () => { restarts++; bridge = { state: 'ready', message: '本机连接已就绪', hint: '', canRetry: false }; return bridge },
    readRuntimeLogs: async (query: RuntimeLogQuery = {}) => {
      if (!logsAvailable) {
        return {
          available: false,
          updatedAt: new Date().toISOString(),
          items: [],
          firstSeq: null,
          lastSeq: null,
          total: 0,
          hasMoreBefore: false,
          hasMoreAfter: false,
          logsPath: null,
        }
      }
      const limit = query.limit ?? 200
      const filtered = runtimeLogs.filter(item => !query.source || item.source === query.source)
      const candidates = query.beforeSeq !== undefined && query.beforeSeq !== null
        ? filtered.filter(item => item.seq < query.beforeSeq!)
        : query.afterSeq !== undefined && query.afterSeq !== null
          ? filtered.filter(item => item.seq > query.afterSeq!)
          : filtered
      const selected = query.afterSeq !== undefined && query.afterSeq !== null ? candidates.slice(0, limit) : candidates.slice(-limit)
      return {
        available: true,
        updatedAt: new Date().toISOString(),
        items: selected,
        firstSeq: selected[0]?.seq ?? null,
        lastSeq: runtimeLogs.at(-1)?.seq ?? null,
        total: filtered.length,
        hasMoreBefore: selected.length > 0 ? filtered.some(item => item.seq < selected[0]!.seq) : false,
        hasMoreAfter: selected.length > 0 ? filtered.some(item => item.seq > selected.at(-1)!.seq) : false,
        logsPath: '/tmp/connector/logs',
      }
    },
    readConnectorLogs: async (query: { before?: number; after?: number } = {}) => {
      const candidates = terminal.filter(entry => (query.before === undefined || entry.id < query.before) && (query.after === undefined || entry.id > query.after))
      return { entries: query.after === undefined ? candidates.slice(-200) : candidates.slice(0, 200), hasMore: candidates.length > 200, oldestId: terminal[0]?.id ?? null, newestId: terminal.at(-1)?.id ?? null }
    },
    readBridgeLogs: async () => ({ updatedAt: new Date().toISOString(), entries: [] }),
  }
  const root = createRoot(document.getElementById('root')!)
  try {
    dom.window.eval(await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8'))
    locale = loadTestLocale(ctx, name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsx
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`Unexpected locale import: ${name}`)
    })
    client.apply({ locale, inject() {}, effect: (fn: any) => fn(), slots: {
      inject: (_name: string, callback: any) => callback(), register: (_options: any, component: any) => { entry = localeEntry(locale, component); return () => {} },
    }, connection: { rpc: {} } })
    await act(async () => { root.render(React.createElement(entry!, { wide: true, host })) })
    const click = async (text: string) => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent === text)!
      assert.ok(button, text)
      await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    }
    await click('远程控制')
    assert.match(document.body.textContent!, /本机连接被占用/)
    await click('查看运行日志')

    // Default interleaved view ('全部') displays plugin, bridge, and connector entries together
    const allRows = [...document.querySelectorAll('details')]
    assert.equal(allRows.length, 3)
    const row = allRows.find(r => r.querySelector('summary')?.textContent?.includes('getSessionState'))!
    assert.ok(row)
    assert.equal(row.open, false)
    assert.match(row.querySelector('summary')!.textContent!, /Bridge/)
    assert.match(row.querySelector('summary')!.textContent!, /ERROR/)
    assert.match(row.querySelector('summary')!.textContent!, /失败/)
    assert.doesNotMatch(row.querySelector('summary')!.textContent!, /TEST_ERROR/)
    row.open = true
    await act(async () => { locale.setLocale('en') })
    assert.ok(row.isConnected)
    assert.equal(row.open, true)
    assert.match(row.querySelector('summary')!.textContent!, /Failed/)
    assert.match(document.body.textContent!, /The local connection is in use/)
    assert.ok(document.querySelector('[aria-label="Runtime log entries"]'))
    await act(async () => { locale.setLocale('zh') })

    // Incremental refresh (afterSeq) preserves expanded details
    runtimeLogs = [
      ...runtimeLogs,
      {
        seq: 4,
        time: '2026-09-10T10:00:03Z',
        source: 'plugin',
        level: 'info',
        name: 'dsh-plugin',
        message: 'onboarding.completed',
        details: null,
        exception: null,
      },
    ]
    await click('刷新')
    assert.ok(row.isConnected)
    assert.equal(row.open, true)
    assert.equal(document.querySelectorAll('details').length, 4)

    // Filter by source: 插件 / Bridge / Connector
    await click('插件')
    assert.equal(document.querySelectorAll('details').length, 2)
    await click('Connector')
    const connectorRows = [...document.querySelectorAll('details')]
    assert.equal(connectorRows.length, 1)
    assert.match(connectorRows[0]!.textContent!, /runtime heartbeat delayed/)
    assert.match(connectorRows[0]!.textContent!, /Traceback: timeout/)

    // Unavailable boundary when Logs RPC is not ready: never disguises local bootstrap logs as unified runtime logs
    logsAvailable = false
    await click('全部')
    assert.equal(document.querySelectorAll('details').length, 0)
    assert.match(document.body.textContent!, /统一运行日志服务尚未就绪/)

    // Pre-startup diagnostics ('启动前诊断') view remains explicitly accessible
    await click('查看启动前诊断')
    const terminalView = document.querySelector('[aria-label="Connector 终端输出"]')!
    assert.equal(terminalView.querySelectorAll('time').length, 200)
    assert.match(terminalView.textContent!, /terminal line 251/)
    assert.match(terminalView.textContent!, /terminal line 450/)
    await click('加载更早的 200 行')
    assert.equal(terminalView.querySelectorAll('time').length, 400)
    await act(async () => { terminalView.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(terminalView.querySelectorAll('time').length, 450)
    terminal.push({ id: 451, time: '2026-09-10T10:00:01Z', text: '<script>plain log</script>' })
    await click('刷新')
    assert.equal(terminalView.querySelectorAll('time').length, 451)
    assert.equal(terminalView.querySelector('script'), null)
    assert.match(terminalView.textContent!, /<script>plain log<\/script>/)

    logsAvailable = true
    await click('Bridge')
    assert.equal(document.querySelectorAll('details').length, 1)
    await click('尝试重启')
    assert.equal(restarts, 1)
    assert.doesNotMatch(document.body.textContent!, /本机连接被占用/)
  } finally {
    await act(async () => { root.unmount() })
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

