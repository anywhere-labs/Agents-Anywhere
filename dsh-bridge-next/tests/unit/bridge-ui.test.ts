import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'

test('published client shows recovery guidance and preserves expanded log rows across refreshes', async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { runScripts: 'outside-only', url: 'https://test.invalid' })
  const values: Record<string, unknown> = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let entry: React.ComponentType<any> | undefined
  let client: any
  let bridge = { state: 'failed', message: '本机连接被占用，无法启动。', hint: '请退出其他正在运行的 DSH，再点击“尝试重启”。', canRetry: true }
  let restarts = 0
  let entries = [{ id: 'one', time: '2026-09-10T10:00:00Z', level: 'error', event: 'rpc.failed', method: 'session.getState', outcome: 'failure', details: '{"errorCode":"TEST_ERROR"}' }]
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
  const host = {
    inspect: async () => ({ desktop: { status: 'installed' }, bridge }),
    restartBridge: async () => { restarts++; bridge = { state: 'ready', message: '本机连接已就绪', hint: '', canRetry: false }; return bridge },
    readBridgeLogs: async () => ({ updatedAt: new Date().toISOString(), entries }),
  }
  const root = createRoot(document.getElementById('root')!)
  try {
    dom.window.eval(await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8'))
    client.apply({ inject() {}, effect: (fn: any) => fn(), slots: {
      inject: (_name: string, callback: any) => callback(), register: (_options: any, component: any) => { entry = component; return () => {} },
    }, connection: { rpc: {} } })
    await act(async () => { root.render(React.createElement(entry!, { wide: true, host })) })
    const click = async (text: string) => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent === text)!
      assert.ok(button, text)
      await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    }
    await click('手机连接')
    assert.match(document.body.textContent!, /本机连接被占用/)
    await click('查看运行日志')
    const row = [...document.querySelectorAll('details')].find(row => row.querySelector('summary')?.textContent?.includes('session.getState'))!
    assert.ok(row)
    assert.equal(row.open, false)
    assert.match(row.querySelector('summary')!.textContent!, /失败/)
    assert.doesNotMatch(row.querySelector('summary')!.textContent!, /TEST_ERROR/)
    row.open = true
    entries = [{ ...entries[0]!, id: 'two', time: '2026-09-10T10:00:01Z' }, ...entries]
    await click('刷新')
    assert.ok(row.isConnected)
    assert.equal(row.open, true)
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
