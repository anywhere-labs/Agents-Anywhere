// S6 (10-development-plan.md §6.1): device resources and recovery of the MeshCall link, against the real Router.
// Not part of `yarn test`; run with
//   AA_S6=1 [AA_S6_IDLE_MS=60000] [AA_S6_OUT=/tmp/s6.json] corepack yarn vitest run test/link/s6.measure.test.ts
import { fork, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ConnectProxy, FakeServer, RouterProcess, routerBinary } from '../support/mesh-harness.js'

const binary = routerBinary()
const enabled = process.env.AA_S6 === '1' && binary !== null
const IDLE_MS = Number(process.env.AA_S6_IDLE_MS ?? 60_000)
const results: Record<string, unknown> = { node: process.version, platform: `${process.platform}-${process.arch}` }

interface Message {
  type: string
  at: number
  state?: string
  connectionId?: string | null
  memory?: NodeJS.MemoryUsage
  cpu?: NodeJS.CpuUsage
  handles?: number | null
  level?: string
  text?: string
}

class DeviceProcess {
  private readonly child: ChildProcess
  public readonly messages: Message[] = []
  private waiters: { test: (message: Message) => boolean; resolve: (message: Message) => void }[] = []

  public constructor() {
    const script = fileURLToPath(new URL('../support/s6-device.ts', import.meta.url))
    const hooks = fileURLToPath(new URL('../support/ts-resolve.mjs', import.meta.url))
    this.child = fork(script, [], { execArgv: ['--experimental-transform-types', '--no-warnings', '--expose-gc', '--import', hooks], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    this.child.on('message', (message: Message) => {
      this.messages.push(message)
      for (const waiter of [...this.waiters]) {
        if (waiter.test(message)) {
          this.waiters = this.waiters.filter(entry => entry !== waiter)
          waiter.resolve(message)
        }
      }
    })
  }

  public get pid(): number {
    return this.child.pid!
  }

  public next(test: (message: Message) => boolean, timeoutMs = 120_000, what = 'message'): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
      this.waiters.push({ test, resolve: message => {
        clearTimeout(timer)
        resolve(message)
      } })
    })
  }

  public online(timeoutMs = 120_000, other?: (message: Message) => boolean): Promise<Message> {
    return this.next(message => message.type === 'state' && message.state === 'online' && (other?.(message) ?? true), timeoutMs, 'online')
  }

  public send(message: Record<string, unknown>): void {
    this.child.send(message)
  }

  /** With `gc`, a full collection first (for memory); without, so the CPU window does not include one. */
  public async sample(gc = true): Promise<Message> {
    if (gc) {
      this.send({ type: 'gc' })
      await this.next(message => message.type === 'gc')
    }
    const reply = this.next(message => message.type === 'sample')
    this.send({ type: 'sample' })
    return reply
  }

  public signal(signal: NodeJS.Signals): void {
    this.child.kill(signal)
  }

  public async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()))
    this.child.kill('SIGKILL')
    await exited
  }
}

function rssKiB(pid: number | undefined): number | null {
  if (pid === undefined) return null
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim())
  } catch {
    return null
  }
}

function stats(values: number[]): { n: number; min: number; median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted.at(-1)! }
}

describe.skipIf(!enabled)('S6: MeshCall device link', () => {
  let router: RouterProcess
  let server: FakeServer

  beforeAll(async () => {
    router = new RouterProcess(binary!)
    await router.start()
    server = new FakeServer(router, 'dev_s6')
    await server.start()
  })

  afterAll(async () => {
    await server.close()
    await router.close()
    const out = process.env.AA_S6_OUT
    if (out !== undefined) writeFileSync(out, JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  })

  function startDevice(proxy: string | null = null, sessions = 50): DeviceProcess {
    const device = new DeviceProcess()
    const credential = server.deviceCredential
    void device.next(message => message.type === 'ready', 30_000, 'child ready').then(() => device.send({ type: 'start', serverUrl: server.url, deviceId: credential.deviceId, token: credential.token, proxy, sessions }))
    return device
  }

  it('idle memory and CPU', async () => {
    const device = startDevice()
    try {
      const started = Date.now()
      const baseline = await device.next(message => message.type === 'baseline')
      await device.online()
      const connectMs = Date.now() - started
      await new Promise(resolve => setTimeout(resolve, 5000))
      const t0 = await device.sample()
      const routerBefore = rssKiB(router.pid)
      await new Promise(resolve => setTimeout(resolve, IDLE_MS))
      const t1 = await device.sample(false)
      const cpuMs = (t1.cpu!.user - t0.cpu!.user + t1.cpu!.system - t0.cpu!.system) / 1000
      const wallMs = t1.at - t0.at
      results.idle = {
        sessions: 50,
        connectMs,
        idleMs: wallMs,
        cpuPercent: Number(((cpuMs / wallMs) * 100).toFixed(3)),
        cpuMsPerMinute: Number(((cpuMs / wallMs) * 60_000).toFixed(1)),
        rssMiB: Number((t1.memory!.rss / 2 ** 20).toFixed(1)),
        heapUsedMiB: Number((t1.memory!.heapUsed / 2 ** 20).toFixed(1)),
        rssGrowthDuringIdleKiB: Math.round((t1.memory!.rss - t0.memory!.rss) / 1024),
        rssAddedByLinkMiB: Number(((t0.memory!.rss - baseline.memory!.rss) / 2 ** 20).toFixed(1)),
        heapAddedByLinkMiB: Number(((t0.memory!.heapUsed - baseline.memory!.heapUsed) / 2 ** 20).toFixed(1)),
        activeHandles: t1.handles,
        heartbeatsSeen: server.held?.heartbeats ?? null,
        routerRssKiB: { before: routerBefore, after: rssKiB(router.pid) },
      }
      expect(cpuMs / wallMs).toBeLessThan(0.05)
    } finally {
      await device.stop()
    }
  }, IDLE_MS + 120_000)

  it('recovery after a Router restart', async () => {
    const device = startDevice()
    try {
      await device.online()
      const fromKill: number[] = []
      const fromUp: number[] = []
      for (let round = 0; round < 5; round++) {
        const before = device.messages.filter(message => message.type === 'state' && message.state === 'online').at(-1)?.connectionId
        const killed = Date.now()
        await router.kill('SIGKILL')
        await router.start()
        const up = Date.now()
        const online = await device.online(60_000, message => message.connectionId !== before)
        fromKill.push(online.at - killed)
        fromUp.push(online.at - up)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      results.routerRestart = { fromKillMs: stats(fromKill), fromRouterUpMs: stats(fromUp) }
    } finally {
      await device.stop()
    }
  }, 300_000)

  it('a half-dead link is kicked by the token revocation of the next hello', async () => {
    const measure = async (revoke: boolean): Promise<number> => {
      server.revokeOnHello = revoke
      const old = startDevice()
      await old.online()
      // Frozen, not closed: its TCP connection stays up and the Router still holds the instance id.
      old.signal('SIGSTOP')
      const started = Date.now()
      const fresh = startDevice()
      try {
        const online = await fresh.online(150_000)
        return online.at - started
      } finally {
        old.signal('SIGCONT')
        await old.stop()
        await fresh.stop()
      }
    }
    const withRevoke = await measure(true)
    const withoutRevoke = await measure(false)
    server.revokeOnHello = true
    results.halfDead = { withRevokeMs: withRevoke, withoutRevokeMs: withoutRevoke, routerIdleTimeoutDefaultMs: 45_000 }
    expect(withRevoke).toBeLessThan(withoutRevoke)
  }, 400_000)

  it('behind an HTTP CONNECT proxy: connect time and recovery after the proxy restarts', async () => {
    const proxy = new ConnectProxy()
    await proxy.start()
    const directDevice = startDevice()
    let direct = 0
    try {
      const started = Date.now()
      await directDevice.online()
      direct = Date.now() - started
    } finally {
      await directDevice.stop()
    }
    const device = startDevice(proxy.url)
    try {
      const started = Date.now()
      await device.online()
      const viaProxy = Date.now() - started
      const before = device.messages.filter(message => message.type === 'state' && message.state === 'online').at(-1)?.connectionId
      const port = proxy.port
      const cut = Date.now()
      await proxy.close()
      await device.next(message => message.type === 'state' && message.state !== 'online', 60_000, 'offline')
      const noticedMs = Date.now() - cut
      await new Promise(resolve => setTimeout(resolve, 2000))
      await proxy.start(port)
      const restored = Date.now()
      const online = await device.online(60_000)
      results.proxy = {
        directConnectMs: direct,
        proxyConnectMs: viaProxy,
        proxyTunnels: proxy.tunnels,
        lossNoticedMs: noticedMs,
        recoveryAfterProxyBackMs: online.at - restored,
        sameGeneration: online.connectionId === before,
      }
    } finally {
      await device.stop()
      await proxy.close()
    }
  }, 300_000)
})
