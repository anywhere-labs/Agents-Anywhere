import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Mesh, Router } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeHandle, RuntimeProvider } from '../../src/application/ports/index.js'
import { codexStableSessionId } from '../../src/domain/identity/index.js'
import { runCli, runDesktopHost, runRpc, startHostProcess, type DesktopHostMessage } from '../../src/entry/index.js'
import { noVault } from '../../src/keystore/index.js'
import { joinChunks } from '../../src/sync/index.js'
import { FakeRuntimeSession, PushQueue } from '../support/fake-runtime-session.js'
import { FakeServer, RouterProcess, routerBinary } from '../support/mesh-harness.js'

const binary = routerBinary()

async function until(condition: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe.skipIf(binary === null)('entry: rpc, CLI and the composition root', () => {
  let home: string
  let router: RouterProcess
  let server: FakeServer

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'aa-home-'))
    router = new RouterProcess(binary!)
    await router.start()
    server = new FakeServer(router)
    await server.start()
  })

  afterEach(async () => {
    await server.close()
    await router.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('rpc: one ready line, Control on the host key, a configured start goes online, stdin EOF exits', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const lines: string[] = []
    stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)))
    const done = runRpc({ home, routerBinary: binary!, compose: { storeMode: 'in-process', providers: [], trust: false, terminals: false } }, { stdin, stdout })
    await until(() => lines.length > 0, 15_000, 'ready line')
    const ready = JSON.parse(lines[0]!) as { kind: string; version: number; pid: number; endpoint: { unixPath: string }; key: string }
    expect(ready).toMatchObject({ kind: 'connector.ready', version: 1, pid: process.pid })
    expect(ready.key).toMatch(/^mk_host_/u)
    // Under <home>/.agents-anywhere/router, or a short temp directory when that path is too long for a socket.
    expect(ready.endpoint.unixPath).toMatch(/\.sock$/u)
    const host = new Mesh(new Router({ unixPath: ready.endpoint.unixPath }), { token: ready.key, retry: false })
    try {
      const paths = await host.unary<object, { configPath: string; runtimePath: string }>('aa.local.v2.Control', 'getPaths', {})
      expect(paths.configPath).toBe(join(home, '.agents-anywhere', 'v3', 'connector.json'))
      expect(paths.runtimePath).toBe(join(home, '.agents-anywhere', 'connector-runtime.json'))
      const credential = server.deviceCredential
      await host.unary('aa.local.v2.Control', 'saveConfig', { config: { serverUrl: server.url, connectorId: credential.deviceId, connectorToken: credential.token } })
      expect(await host.unary('aa.local.v2.Control', 'start', { config: null })).toMatchObject({ status: 'running' })
      // The composition root opened the store and the device link reached the (fake) Server through the Router.
      await until(() => server.held !== null, 15_000, 'device held by the Server')
      expect(server.calls.slice(0, 3)).toEqual(['/api/v3/device/auth', '/api/v3/device/hello', '/api/v3/device/ready'])
      expect(existsSync(join(home, '.agents-anywhere', 'v3', 'store'))).toBe(true)
      const logs = await host.unary<object, { items: { message: string }[] }>('aa.local.v2.Logs', 'read', { source: 'connector' })
      expect(logs.items.some(item => item.message.includes('device link online'))).toBe(true)
    } finally {
      await host.close()
    }
    stdin.end()
    await done
    // Nothing but the ready line on stdout; the lease and the handover file are gone.
    expect(lines).toHaveLength(1)
    expect(server.held).not.toBeNull()
  }, 40_000)

  it('CLI: configure saves, start runs until stopped, pair-client needs encrypted-mode support, --version', async () => {
    const out: string[] = []
    const err: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }
    const credential = server.deviceCredential
    expect(await runCli(['configure', '--server-url', server.url, '--connector-id', credential.deviceId, '--connector-token', credential.token], { io, home, routerBinary: binary!, until: new Promise(() => undefined) })).toBe(0)
    expect(out.at(-1)).toContain(join(home, '.agents-anywhere', 'v3', 'connector.json'))

    let stop!: () => void
    const stopped = new Promise<void>(resolve => (stop = resolve))
    const running = runCli(['start'], { io, home, routerBinary: binary!, until: stopped, compose: { storeMode: 'in-process', providers: [], trust: false, terminals: false } })
    await until(() => server.held !== null, 20_000, 'online').catch(error => {
      throw new Error(`${(error as Error).message}\n${err.join('\n')}`)
    })
    expect(out).toContain('connector 3.0.0-dev running; press Ctrl-C to stop')
    stop()
    expect(await running).toBe(0)

    expect(await runCli(['pair-client'], { io, home, routerBinary: binary! })).toBe(1)
    expect(err.some(line => line.includes('not available in this build'))).toBe(true)
    expect(await runCli(['pair-client'], { io, home, routerBinary: binary!, clientPairing: async () => ({ uri: 'aa-pair://abc', payload: { expiresAt: '2026-11-17T00:10:00.000Z' } }) })).toBe(0)
    expect(out).toContain('aa-pair://abc')
    expect(out.some(line => line.includes('█'))).toBe(true)
    expect(await runCli(['--version'], { io })).toBe(0)
    expect(await runCli(['bogus'], { io })).toBe(64)
  }, 60_000)

  it('composition root: Runtimes are announced, native sessions scanned into session.inventory and opened on demand', async () => {
    const opened: string[] = []
    const handle: RuntimeHandle = {
      type: 'codex',
      instanceId: 'codex',
      capabilities: () => ({ revision: 3, items: [{ id: 'runtime.steer', supported: true }] }),
      catalogs: async () => ({ selections: { model: null } }),
      listNativeSessions: async () => ({ sessions: [{ nativeSessionId: 'thr_1', title: 'Fix the build', cwd: '/w', updatedAt: '2026-11-17T00:00:00.000Z' }] }),
      readNativeHistory: async () => ({ items: [{ type: 'message.completed', itemId: 'm1', role: 'user', text: 'hello' }] as never }),
      open: async (target, options) => {
        opened.push(target.kind === 'existing' ? target.ref.nativeSessionId : 'new')
        return new FakeRuntimeSession(options.sessionId, 'thr_1')
      },
      events: new PushQueue(),
      stop: async () => undefined,
    }
    const provider: RuntimeProvider = {
      type: 'codex',
      discover: async () => ({ type: 'codex', displayName: 'Codex', installed: true, agentVersion: '0.166.0', problems: [], instancePolicy: 'multiple', processScope: 'shared' }),
      start: async () => handle,
    }
    const host = await startHostProcess({ kind: 'cli', home, routerBinary: binary!, compose: { storeMode: 'in-process', providers: [provider], trust: { vault: noVault() }, terminals: false } })
    try {
      const credential = server.deviceCredential
      await host.controller.start({ serverUrl: server.url, connectorId: credential.deviceId, connectorToken: credential.token })
      await until(() => server.held?.events.some(event => event.m === 'runtime.status' && event.p.runtimeId === 'codex') === true, 15_000, 'runtime.status')
      const status = server.held!.events.find(event => event.m === 'runtime.status' && event.p.runtimeId === 'codex')!
      expect(status.p.status).toMatchObject({ runtimeType: 'codex', installed: true, agentVersion: '0.166.0', displayName: 'Codex' })
      await until(() => server.outbox.some(item => item.m === 'session.inventory'), 15_000, 'session.inventory')
      const inventory = server.outbox.find(item => item.m === 'session.inventory')!
      const sessionId = codexStableSessionId(credential.deviceId, 'thr_1')
      expect(inventory.p).toMatchObject({ runtimeId: 'codex', complete: true })
      expect((inventory.p.sessions as { sessionId: string }[]).map(session => session.sessionId)).toEqual([sessionId])
      // A client snapshot reads the projected history and the Runtime's facts.
      const chunks = await server.stream<{ seq: number; chunk: string; end: boolean }>('aa.device.v1.Sessions', 'snapshot', { sessionId })
      const snapshot = joinChunks(chunks) as { timeline: { items: { id: string }[] }; runtimeCapabilities: { revision: number; capabilities: { capabilityId: string }[] } }
      expect(snapshot.timeline.items.map(item => item.id)).toEqual(['m1'])
      expect(snapshot.runtimeCapabilities).toMatchObject({ revision: 3, capabilities: [{ capabilityId: 'runtime.steer', scope: 'runtime' }] })
      expect(opened).toEqual([])
    } finally {
      await host.shutdown()
    }
  }, 40_000)

  it('desktop-host: ready over parentPort, Control reachable, shutdown message stops it', async () => {
    const posted: DesktopHostMessage[] = []
    let deliver!: (event: { data: unknown }) => void
    const port = { postMessage: (message: unknown) => posted.push(message as DesktopHostMessage), on: (_event: 'message', listener: (event: { data: unknown }) => void) => (deliver = listener) }
    const done = runDesktopHost(port, { home, routerBinary: binary! })
    await until(() => posted.length > 0, 15_000, 'ready message')
    const ready = posted[0] as Extract<DesktopHostMessage, { type: 'ready' }>
    expect(ready).toMatchObject({ type: 'ready', kind: 'connector.ready', version: 1, pid: process.pid })
    const endpoint = ready.endpoint as { unixPath: string }
    const host = new Mesh(new Router({ unixPath: endpoint.unixPath }), { token: ready.key, retry: false })
    expect(await host.unary('aa.local.v2.Control', 'getState', {})).toMatchObject({ status: 'stopped' })
    await host.close()
    deliver({ data: { type: 'shutdown' } })
    await done
    expect(posted.at(-1)).toEqual({ type: 'stopped', reason: 'shutdown' })
  }, 30_000)
})
