// 子进程管道出错（Agent 退出瞬间写入的 EPIPE）只关闭这条 Runtime 连接，不让 Connector 进程崩溃。
import { describe, expect, it } from 'vitest'

import { runtimeError } from '../../src/runtime/acp/session.js'
import { ConnectionClosedError } from '../../src/runtime/acp/jsonrpc.js'
import { AgentProcess } from '../../src/runtime/supervisor/agent-process.js'

function agent(script: string): AgentProcess {
  return new AgentProcess({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env }, { killAfterMs: 500 })
}

describe('AgentProcess stdio failures', () => {
  it('a write into a pipe the agent closed (EPIPE) closes the connection instead of crashing', async () => {
    // 进程还活着，但已经关掉了自己的 stdin：之后的写入异步报 EPIPE。
    const process_ = agent("require('node:fs').closeSync(0); setTimeout(() => {}, 5000)")
    await new Promise(resolve => setTimeout(resolve, 300))
    const big = 'x'.repeat(256 * 1024)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => process_.peer.request('session/prompt', { text: big })))
    const reason = await process_.peer.whenClosed()
    expect(reason).toMatch(/EPIPE|write|closed/i)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      const error = (result as PromiseRejectedResult).reason
      expect(error).toBeInstanceOf(ConnectionClosedError)
      expect(runtimeError(error).code).toBe('runtime_disconnected')
    }
    expect(() => process_.peer.notify('session/cancel', {})).toThrow(ConnectionClosedError)
    await process_.stop()
  })

  it('writing to an agent that already exited is rejected as runtime_disconnected', async () => {
    const process_ = agent('process.exit(0)')
    await process_.exited()
    const error = await process_.peer.request('initialize', { protocolVersion: 1 }).catch((e: unknown) => e)
    expect(runtimeError(error).code).toBe('runtime_disconnected')
    expect(process_.alive).toBe(false)
  })
})
