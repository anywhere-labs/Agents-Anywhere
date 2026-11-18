import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
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

function pairingPayload(uri: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(uri.slice('aa-pair://'.length), 'base64url').toString('utf8')) as Record<string, unknown>
}

function ownerInstanceId(home: string): string {
  return (JSON.parse(readFileSync(join(home, '.agents-anywhere', 'connector-runtime.json'), 'utf8')) as { runtime: { instanceId: string } }).runtime.instanceId
}

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

  it('CLI: configure saves, start runs until stopped, --version', async () => {
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

    expect(await runCli(['--version'], { io })).toBe(0)
    expect(await runCli(['bogus'], { io })).toBe(64)
  }, 60_000)

  it('CLI pair-client as the host: starts the Connector and prints an invitation of the Server\'s encrypted mode', async () => {
    server.e2eeMode = 'required'
    const out: string[] = []
    const err: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }
    const credential = server.deviceCredential
    expect(await runCli(['configure', '--server-url', server.url, '--connector-id', credential.deviceId, '--connector-token', credential.token], { io, home, routerBinary: binary! })).toBe(0)
    let stop!: () => void
    const stopped = new Promise<void>(resolve => (stop = resolve))
    const running = runCli(['pair-client'], { io, home, routerBinary: binary!, until: stopped, confirm: null, compose: { storeMode: 'in-process', providers: [], trust: { vault: noVault() }, terminals: false } })
    await until(() => out.some(line => line.startsWith('aa-pair://')), 30_000, 'pairing link').catch(error => {
      throw new Error(`${(error as Error).message}\n${err.join('\n')}`)
    })
    const payload = pairingPayload(out.find(line => line.startsWith('aa-pair://'))!)
    expect(payload).toMatchObject({ v: 1, deviceId: credential.deviceId, serverUrl: server.url, e2eeMode: 'required' })
    expect(out.some(line => line.includes('█'))).toBe(true)
    expect(out.some(line => /^Device fingerprint: [0-9a-f]{4}( [0-9a-f]{4}){7}$/u.test(line))).toBe(true)
    expect(out.at(-1)).toContain('keep it running until the client has paired')
    stop()
    expect(await running).toBe(0)
  }, 60_000)

  it('CLI pair-client against a Server without encryption: refused with an explanation', async () => {
    const out: string[] = []
    const err: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }
    const credential = server.deviceCredential
    expect(await runCli(['configure', '--server-url', server.url, '--connector-id', credential.deviceId, '--connector-token', credential.token], { io, home, routerBinary: binary! })).toBe(0)
    expect(await runCli(['pair-client'], { io, home, routerBinary: binary!, until: new Promise(() => undefined), confirm: null, compose: { storeMode: 'in-process', providers: [], trust: { vault: noVault() }, terminals: false } })).toBe(1)
    expect(err.some(line => line.includes('does not use end-to-end encryption'))).toBe(true)
    expect(out.some(line => line.startsWith('aa-pair://'))).toBe(false)
  }, 60_000)

  it('CLI pair-client while another host owns the machine: asks it over the local control interface', async () => {
    server.e2eeMode = 'required'
    const desktop = await startHostProcess({ kind: 'desktop-workbench', home, routerBinary: binary!, compose: { storeMode: 'in-process', providers: [], trust: { vault: noVault() }, terminals: false } })
    try {
      const credential = server.deviceCredential
      // Desktop's own configuration; the CLI has none and does not need one.
      await desktop.controller.start({ serverUrl: server.url, connectorId: credential.deviceId, connectorToken: credential.token })
      await until(() => server.held !== null, 20_000, 'online')
      const out: string[] = []
      const err: string[] = []
      const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }
      expect(await runCli(['pair-client'], { io, home, routerBinary: binary! })).toBe(0)
      const payload = pairingPayload(out.find(line => line.startsWith('aa-pair://'))!)
      expect(payload).toMatchObject({ deviceId: credential.deviceId, serverUrl: server.url, e2eeMode: 'required' })
      expect(out.at(-1)).toContain('(desktop-workbench, PID')
      // The owner still runs (the CLI never competed for the machine) and holds that pairing's psk.
      expect(desktop.controller.getState().running).toBe(true)

      // The published key may ask for a pairing and nothing else.
      const rendezvous = JSON.parse(readFileSync(join(home, '.agents-anywhere', 'router', `${ownerInstanceId(home)}.pairing.json`), 'utf8')) as { endpoint: { unixPath: string }; key: string }
      expect(rendezvous.key).toMatch(/^mk_client-pairing_/u)
      const peer = new Mesh(new Router({ unixPath: rendezvous.endpoint.unixPath }), { token: rendezvous.key, retry: false, reconnect: { enabled: false } })
      try {
        await expect(peer.unary('aa.local.v2.Control', 'getState', {})).rejects.toThrow()
        await expect(peer.unary('aa.local.v2.Control', 'grantLocalClient', { clientIdentityPub: Buffer.alloc(32, 7).toString('base64url') })).rejects.toThrow()
        await expect(peer.unary('aa.local.v2.Control', 'answerConfirmation', { confirmationId: 'conf_x', approved: true })).rejects.toThrow()
        expect(await peer.unary('aa.local.v2.Control', 'startClientPairing', {})).toMatchObject({ deviceId: credential.deviceId })
      } finally {
        await peer.close()
      }
      // The host key also reaches the trust controls (Desktop): an unknown confirmation is not accepted.
      const host = new Mesh(new Router({ unixPath: rendezvous.endpoint.unixPath }), { token: desktop.descriptor.key, retry: false })
      try {
        expect(await host.unary('aa.local.v2.Control', 'answerConfirmation', { confirmationId: 'conf_unknown', approved: true })).toEqual({ accepted: false })
      } finally {
        await host.close()
      }
    } finally {
      await desktop.shutdown()
    }
  }, 60_000)

  it('local confirmation through the control interface: Desktop follows requests and answers; no answer refuses', async () => {
    const desktop = await startHostProcess({ kind: 'desktop-workbench', home, routerBinary: binary! })
    const endpoint = desktop.descriptor.endpoint as { unixPath: string }
    const host = new Mesh(new Router({ unixPath: endpoint.unixPath }), { token: desktop.descriptor.key, retry: false })
    const abort = new AbortController()
    try {
      const request = { approverLabel: 'Phone', label: 'Browser', fingerprint: '0123 4567 89ab cdef 0123 4567 89ab cdef' }
      // Nobody follows yet: refused at once.
      expect(await desktop.confirmations.confirmClientApproval(request)).toBe(false)
      const seen: { kind: string; confirmation?: { confirmationId: string; label: string }; approved?: boolean }[] = []
      const following = (async () => {
        for await (const event of host.serverStream<object, (typeof seen)[number]>('aa.local.v2.Control', 'confirmations', {}, { signal: abort.signal })) {
          seen.push(event)
          if (event.kind === 'requested') await host.unary('aa.local.v2.Control', 'answerConfirmation', { confirmationId: event.confirmation!.confirmationId, approved: seen.length === 1 })
        }
      })().catch(() => undefined)
      await until(() => desktop.confirmations.answerable, 10_000, 'subscriber')
      expect(await desktop.confirmations.confirmClientApproval(request)).toBe(true)
      expect(await desktop.confirmations.confirmClientApproval(request)).toBe(false)
      await until(() => seen.length === 4, 10_000, 'settlements')
      expect(seen.map(event => `${event.kind}:${event.approved ?? event.confirmation?.label}`)).toEqual(['requested:Browser', 'settled:true', 'requested:Browser', 'settled:false'])
      abort.abort()
      await following
    } finally {
      await host.close()
      await desktop.shutdown()
    }
  }, 30_000)

  it('composition root: Runtimes are announced, native sessions scanned into session.inventory and opened on demand', async () => {
    const opened: string[] = []
    const handle: RuntimeHandle = {
      type: 'codex',
      instanceId: 'codex',
      capabilities: () => ({ revision: 3, items: [{ id: 'runtime.steer', supported: true }] }),
      catalogs: async () => ({ models: { runtime: 'codex', revision: 4, models: [{ id: 'gpt-5', displayName: 'GPT-5', selectionId: 'gpt-5' }] } as never, selections: { model: null } }),
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
    const root = mkdtempSync(join(tmpdir(), 'aa-root-'))
    writeFileSync(join(root, 'blob.bin'), 'abc')
    const host = await startHostProcess({ kind: 'cli', home, routerBinary: binary!, compose: { storeMode: 'in-process', providers: [provider], trust: { vault: noVault() }, terminals: false, workspaceRoots: [root] } })
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
      // The client API answers with what the composition root wired: instance catalogs, session slash commands and
      // file downloads through the transfer relay.
      const clientCall = async (request: Record<string, unknown>): Promise<{ head: { status: number }; body: Record<string, unknown> }> => {
        const [head, ...chunks] = await server.stream<{ kind: string; status: number }>('aa.device.v1.Client', 'call', { caller: { userId: 'usr_1' }, ...request })
        return { head: head!, body: joinChunks(chunks as never) as Record<string, unknown> }
      }
      // A client snapshot reads the projected history and the Runtime's facts.
      const snapshot = (await clientCall({ route: 'session.snapshot', method: 'GET', path: `/api/v2/sessions/${sessionId}/snapshot` })).body as { timeline: { items: { id: string }[] }; runtimeCapabilities: { revision: number; capabilities: { capabilityId: string }[] } }
      expect(snapshot.timeline.items.map(item => item.id)).toEqual(['m1'])
      // Codex's declared capabilities with the handle's live ones on top, plus the session engine's releasing and
      // reopening of the Agent session (neither applies to a session never opened).
      expect(snapshot.runtimeCapabilities.revision).toBe(3)
      expect(snapshot.runtimeCapabilities.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ capabilityId: 'runtime.steer', scope: 'runtime' }),
        expect.objectContaining({ capabilityId: 'session.planning', supported: true, scope: 'runtime' }),
        expect.objectContaining({ capabilityId: 'session.close', supported: true, available: false }),
        expect.objectContaining({ capabilityId: 'session.recover', supported: true, available: false }),
      ]))
      expect(opened).toEqual([])
      const dev = `/api/v2/connectors/${credential.deviceId}`
      const models = await clientCall({ route: 'connector.runtime.catalogs.model', method: 'GET', path: `${dev}/runtimes/codex/catalogs/model` })
      expect(models.head.status).toBe(200)
      expect(models.body.catalog).toMatchObject({ runtime: 'codex', revision: 4, models: [{ id: 'gpt-5' }] })
      const missing = await clientCall({ route: 'connector.runtime.catalogs.model', method: 'GET', path: `${dev}/runtimes/rt_none/catalogs/model` })
      expect(missing.head.status).toBe(404)
      const download = await clientCall({
        route: 'connector.fs.read',
        method: 'POST',
        path: `${dev}/fs/read`,
        query: { root },
        body: { path: 'blob.bin' },
        server: { transfer: { transferId: 'tr_1', token: 'tok_1', path: '/api/v3/device/transfers/tr_1' } },
      })
      expect(download.head.status).toBe(200)
      expect(download.body).toMatchObject({ ok: true, result: { transferId: 'tr_1', token: 'tok_1', size: 3 } })
      await until(() => server.transfers.has('tr_1'), 10_000, 'the transfer upload')
      expect(server.transfers.get('tr_1')).toMatchObject({ token: 'tok_1', bytes: Buffer.from('abc') })
    } finally {
      await host.shutdown()
      rmSync(root, { recursive: true, force: true })
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
