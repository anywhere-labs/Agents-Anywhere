/**
 * Tests for the subprocess lifecycle daemon.
 *
 * Strategy:
 *   - Spawn `node -e "<script>"` (or a tiny shell snippet) so we can
 *     observe capture without depending on `uv`.
 *   - Mock `child_process.spawn` via Vitest so we can drive a fake
 *     `ChildProcess` whose streams we control. This keeps the test hermetic
 *     and lets us assert timing-sensitive behavior without relying on real
 *     process scheduling.
 */

import { spawn as realSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessRunner } from '../src/manager/process-runner.js'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

const spawnMock = vi.mocked(realSpawn)

class FakeChildProcess extends EventEmitter {
  pid = 4321
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true
    const sigName = typeof signal === 'number' ? null : signal
    this.signalCode = (sigName ?? null) as NodeJS.Signals | null
    queueMicrotask(() => this.emit('exit', this.exitCode, this.signalCode))
    return true
  }
}

let activeChild: FakeChildProcess | null = null

beforeEach(() => {
  activeChild = null
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess()
    activeChild = child
    return child as unknown as ReturnType<typeof realSpawn>
  })
})

afterEach(() => {
  spawnMock.mockReset()
})

describe('ProcessRunner', () => {
  it('spawns the command and flips state to running', () => {
    const runner = new ProcessRunner()
    expect(runner.getState()).toBe('stopped')

    const ok = runner.start({ command: 'node', args: ['-e', 'process.stdin.resume()'] })
    expect(ok).toBe(true)
    expect(runner.getState()).toBe('running')
    expect(runner.getPid()).toBe(4321)
  })

  it('rejects a second start while already running', () => {
    const runner = new ProcessRunner()
    runner.start({ command: 'node', args: ['-e', '0'] })
    expect(runner.start({ command: 'node', args: ['-e', '0'] })).toBe(false)
  })

  it('ignores stdout and grades stderr lines by content', () => {
    const runner = new ProcessRunner()
    const received: Array<{ level: string; message: string }> = []
    runner.on('log', (entry) => received.push({ level: entry.level, message: entry.message }))

    runner.start({ command: 'node', args: ['-e', '0'] })
    const child = activeChild
    if (child === null) throw new Error('child not created')

    // stdout carries the JSON-RPC protocol stream, consumed by RpcClient, and
    // must NOT surface as logs — only stderr is a log source.
    child.stdout.write('{"jsonrpc":"2.0","method":"connector/state"}\n')
    // Plain stderr (uv install progress) is informational, not an error.
    child.stderr.write('Resolved 42 packages in 12ms\n')
    // A line that looks like a real failure grades as error.
    child.stderr.write('Traceback (most recent call last): boom\n')
    child.emit('exit', 0, null)

    expect(received.length).toBe(2)
    expect(received[0]).toEqual({ level: 'info', message: 'Resolved 42 packages in 12ms' })
    expect(received[1]).toEqual({ level: 'error', message: 'Traceback (most recent call last): boom' })
  })

  it('drops to crashed when the child exits non-zero', async () => {
    const runner = new ProcessRunner()
    const states: string[] = []
    runner.on('state', (state) => states.push(state))

    runner.start({ command: 'node', args: ['-e', 'process.exit(7)'] })
    const child = activeChild
    if (child === null) throw new Error('child not created')

    child.stdout.write('halfway\n')
    child.emit('exit', 7, null)

    expect(states).toContain('running')
    expect(states.at(-1)).toBe('crashed')
    expect(runner.getState()).toBe('crashed')
    expect(runner.getPid()).toBeNull()
  })

  it('stop() sends SIGTERM and only escalates to SIGKILL after the deadline', async () => {
    vi.useFakeTimers()
    try {
      const runner = new ProcessRunner({ gracefulStopMs: 1000 })
      runner.start({ command: 'node', args: ['-e', '0'] })
      const child = activeChild
      if (child === null) throw new Error('child not created')

      const stopPromise = runner.stop()
      // Allow the queued microtask `exit` event from kill() to fire.
      await vi.advanceTimersByTimeAsync(0)
      await stopPromise

      expect(runner.getState()).toBe('stopped')
      // kill() was called at least once (graceful SIGTERM).
      expect(child.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates spawn errors as state=crashed + error event', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT: uv not found')
    })
    const runner = new ProcessRunner()
    let captured: Error | null = null
    runner.on('error', (error) => { captured = error })

    const ok = runner.start({ command: 'uv', args: ['run', 'connector', 'rpc'] })
    expect(ok).toBe(false)
    expect(runner.getState()).toBe('crashed')
    expect(captured).toBeInstanceOf(Error)
    expect((captured as unknown as Error).message).toContain('ENOENT')
  })
})