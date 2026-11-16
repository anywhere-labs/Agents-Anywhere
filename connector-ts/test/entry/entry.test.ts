import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Mesh, Router } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, runDesktopHost, runRpc, type DesktopHostMessage } from '../../src/entry/index.js'
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
    const done = runRpc({ home, routerBinary: binary!, compose: { storeMode: 'in-process' } }, { stdin, stdout })
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
    const running = runCli(['start'], { io, home, routerBinary: binary!, until: stopped, compose: { storeMode: 'in-process' } })
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
    expect(await runCli(['--version'], { io })).toBe(0)
    expect(await runCli(['bogus'], { io })).toBe(64)
  }, 60_000)

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
