import { describe, expect, it } from 'vitest'

import { AgentPool, backoffMs, type PooledConnection } from '../../src/runtime/supervisor/agent-pool.js'

class FakeConnection implements PooledConnection {
  readonly startedAt: number
  alive = true
  expectedExit = false
  private resolveExit!: (reason: string) => void
  private readonly exit = new Promise<string>(resolve => (this.resolveExit = resolve))
  constructor(now: number) {
    this.startedAt = now
  }
  exited(): Promise<string> {
    return this.exit
  }
  crash(reason: string): void {
    this.alive = false
    this.resolveExit(reason)
  }
  async stop(): Promise<void> {
    this.expectedExit = true
    this.alive = false
    this.resolveExit('stopped')
  }
}

describe('AgentPool', () => {
  it('backs off after repeated crashes and resets after a stable run', async () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([0, 2000, 4000, 8000, 60_000])
    let now = 1_000_000
    const started: FakeConnection[] = []
    const pool = new AgentPool<FakeConnection>({
      start: async () => {
        const c = new FakeConnection(now)
        started.push(c)
        return c
      },
      busy: () => false,
      attached: () => true,
      lastActivity: () => now,
      now: () => now,
    })
    const first = await pool.acquire()
    expect(await pool.acquire()).toBe(first)
    first.crash('boom')
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await pool.acquire() // the first crash restarts immediately
    second.crash('boom again')
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(pool.acquire()).rejects.toThrow(/retrying in 2 s/)
    expect(pool.state()).toMatchObject({ running: false, failures: 2 })
    now += 2001
    const third = await pool.acquire()
    now += 61_000
    third.crash('late crash')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pool.state().failures).toBe(1)
    await pool.acquire()
    expect(started).toHaveLength(4)
  })

  it('stops an idle process sooner when no session uses it', async () => {
    let now = 0
    let attached = false
    const pool = new AgentPool<FakeConnection>({
      start: async () => new FakeConnection(now),
      busy: () => false,
      attached: () => attached,
      lastActivity: () => 0,
      idleMs: 10 * 60_000,
      now: () => now,
    })
    const c = await pool.acquire()
    now = 30_000
    pool.checkIdle(now)
    expect(c.alive).toBe(true)
    now = 61_000
    pool.checkIdle(now)
    expect(c.alive).toBe(false)
    attached = true
    const d = await pool.acquire()
    pool.checkIdle(now + 61_000)
    expect(d.alive).toBe(true)
    await pool.shutdown()
  })
})
