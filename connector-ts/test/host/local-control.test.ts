import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Mesh, Router, type RpcStream } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ConfigFile,
  ConnectorController,
  ControlEvents,
  LocalHub,
  LogStore,
  RuntimeLease,
  controlService,
  handoverRequester,
  logsService,
  publishHandover,
  type FetchJson,
  type LocalRole,
} from '../../src/host/index.js'
import { routerBinary } from '../support/mesh-harness.js'

const binary = routerBinary()

async function until(condition: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe.skipIf(binary === null)('local control channel (aa.local.v2) on a real local Router', () => {
  let dir: string
  let hub: LocalHub
  let controller: ConnectorController
  let events: ControlEvents
  let logs: LogStore
  let clients: Mesh[]
  let runs: { connectorId: string; stopDelayMs: number; fail?: Error }[]
  let fetchJson: FetchJson
  let pollAnswers: Record<string, unknown>[]

  const settings = { serverUrl: 'https://aa.example.test', connectorId: 'conn_1', connectorToken: 'ct_secret' }

  function makeController(lease: RuntimeLease, extra: Partial<ConstructorParameters<typeof ConnectorController>[0]> = {}): ConnectorController {
    return new ConnectorController({
      config: new ConfigFile(join(dir, 'connector.json')),
      lease,
      runtimePath: join(dir, 'connector-runtime.json'),
      fetchJson: (...args) => fetchJson(...args),
      runtime: (config, hooks) => ({
        run: signal => new Promise<void>((resolve, reject) => {
          const entry = runs.at(-1) ?? { connectorId: config.connectorId, stopDelayMs: 0 }
          runs.push({ connectorId: config.connectorId, stopDelayMs: entry.stopDelayMs })
          hooks.deviceSettings({ confirmQuitOnShutdown: true })
          if (entry.fail !== undefined) return reject(entry.fail)
          signal.addEventListener('abort', () => setTimeout(resolve, entry.stopDelayMs), { once: true })
        }),
      }),
      notify: (kind, payload) => events.publish(kind, payload),
      ...extra,
    })
  }

  function lease(version = '3.0.0'): RuntimeLease {
    return new RuntimeLease({ path: join(dir, 'connector-runtime.json'), identity: { kind: 'cli', version, schemaVersion: 1 } })
  }

  function client(role: LocalRole, from: LocalHub = hub): Mesh {
    const endpoint = from.endpoint
    const mesh = new Mesh(new Router('unixPath' in endpoint ? { unixPath: endpoint.unixPath } : { pipe: endpoint.pipe }), { token: from.key(role), retry: false })
    clients.push(mesh)
    return mesh
  }

  const call = <T>(mesh: Mesh, method: string, request: Record<string, unknown> = {}, service = 'aa.local.v2.Control'): Promise<T> =>
    mesh.unary<Record<string, unknown>, T>(service, method, request, { timeoutMs: 10_000 })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-local-'))
    runs = []
    clients = []
    pollAnswers = []
    fetchJson = async () => ({})
    events = new ControlEvents()
    logs = await LogStore.open(join(dir, 'logs'))
    controller = makeController(lease())
    hub = new LocalHub({ directory: join(dir, 'router'), binaryPath: binary! })
    await hub.start()
    await hub.mount(controlService(controller, events), logsService(logs))
  })

  afterEach(async () => {
    for (const mesh of clients) await mesh.close().catch(() => undefined)
    await controller.shutdown().catch(() => undefined)
    await hub.stop()
    await logs.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('configures, starts, stops and reports state and events to the host', async () => {
    const host = client('host')
    expect(await call(host, 'getState')).toMatchObject({ status: 'stopped', running: false, hasConfig: false, deviceSettings: null })
    expect(await call(host, 'getConfig')).toMatchObject({ serverUrl: '', connectorId: '' })
    const stream = host.serverStream<Record<string, unknown>, { seq: number; kind: string; state: { status: string } | null }>('aa.local.v2.Control', 'events', { since: null })
    expect(await call(host, 'saveConfig', { config: settings })).toMatchObject(settings)
    expect(await call(host, 'start', { config: null })).toMatchObject({ status: 'running', running: true, hasConfig: true })
    expect(runs.map(run => run.connectorId)).toEqual(['conn_1'])
    expect(await call(host, 'getState')).toMatchObject({ deviceSettings: { confirmQuitOnShutdown: true } })
    expect(await call(host, 'stop')).toMatchObject({ status: 'stopped', running: false })
    const seen: string[] = []
    for await (const event of stream as RpcStream<{ seq: number; kind: string; state: { status: string } | null }>) {
      if (event.kind === 'state') seen.push(event.state!.status)
      if (seen.at(-1) === 'stopped' && seen.includes('running')) break
    }
    await stream.cancel()
    expect(seen).toContain('running')
    // The connector id was recorded in the shared machine history.
    expect(existsSync(join(dir, 'connector-runtime.json'))).toBe(true)
  }, 30_000)

  it('answers connector_busy while a stop is still cleaning up, and maps bad input', async () => {
    const host = client('host')
    await call(host, 'saveConfig', { config: settings })
    runs.push({ connectorId: 'x', stopDelayMs: 500 })
    await call(host, 'start')
    const stopping = call(host, 'stop')
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(call(host, 'restart')).rejects.toMatchObject({ code: 'connector_busy', retryable: false })
    await stopping
    await expect(call(host, 'saveConfig', { config: { serverUrl: 'x' } })).rejects.toMatchObject({ code: 'invalid_argument' })
  }, 30_000)

  it('reports a refused credential as expired credential', async () => {
    const host = client('host')
    await call(host, 'saveConfig', { config: settings })
    runs.push({ connectorId: 'x', stopDelayMs: 0, fail: Object.assign(new Error('refused'), { code: 'credential_rejected' }) })
    await call(host, 'start')
    await until(() => controller.getState().status === 'expired credential', 5000, 'expired credential')
    expect(controller.getState()).toMatchObject({ authFailed: true, running: false })
  }, 20_000)

  it('pairs: waiting with a code, then saves the claimed credentials and starts', async () => {
    pollAnswers = [{ status: 'pending' }, { status: 'claimed', config: settings }]
    fetchJson = async (method, url) => {
      if (url.endsWith('/api/v2/pairing/start')) return { pairingId: 'pair_1', code: 'ABC-123' }
      if (url.endsWith('/api/v2/pairing/poll')) return pollAnswers.shift() ?? { status: 'pending' }
      throw new Error(`unexpected ${method} ${url}`)
    }
    const host = client('host')
    const stream = host.serverStream<Record<string, unknown>, { kind: string; pairing: { status: string; code?: string } | null }>('aa.local.v2.Control', 'events', { since: null })
    expect(await call(host, 'startPairing', { server: 'https://aa.example.test', pollInterval: 0.01 })).toMatchObject({ status: 'starting', serverUrl: 'https://aa.example.test' })
    const pairing: { status: string; code?: string }[] = []
    for await (const event of stream) {
      if (event.kind === 'pairing') pairing.push(event.pairing!)
      if (pairing.at(-1)?.status === 'claimed') break
    }
    await stream.cancel()
    expect(pairing.map(item => item.status)).toEqual(['starting', 'waiting', 'claimed'])
    expect(pairing[1]?.code).toBe('ABC-123')
    expect(new ConfigFile(join(dir, 'connector.json')).load()).toMatchObject(settings)
    expect(controller.getState().running).toBe(true)
  }, 20_000)

  it('gives each role only what local-machine 2.0 allows', async () => {
    const bridge = client('dsh-bridge')
    await expect(call(bridge, 'getState')).rejects.toMatchObject({ code: 'permission_denied' })
    const write = { entries: [{ time: new Date().toISOString(), level: 'INFO', name: 'dsh', message: 'hello password=abc123secret', producer: 'p1', eventId: 'e1' }] }
    expect(await call(bridge, 'write', write, 'aa.local.v2.Logs')).toEqual({ accepted: 1 })
    expect(await call(bridge, 'write', write, 'aa.local.v2.Logs')).toEqual({ accepted: 0 })
    const page = await call<{ items: { message: string; source: string }[] }>(bridge, 'read', { source: 'bridge' }, 'aa.local.v2.Logs')
    expect(page.items.map(item => item.source)).toEqual(['bridge'])
    expect(page.items[0]?.message).not.toContain('abc123secret')
    await expect(call(bridge, 'clear', {}, 'aa.local.v2.Logs')).rejects.toMatchObject({ code: 'permission_denied' })
    const handover = client('handover')
    await expect(call(handover, 'getState')).rejects.toMatchObject({ code: 'permission_denied' })
    expect(await call(handover, 'requestHandover', { version: '2.9.0' })).toEqual({ accepted: false, reason: 'not_available' })
  }, 20_000)

  it('restarts a Router that died, on the same endpoint and keys', async () => {
    const host = client('host')
    await call(host, 'getState')
    const pid = (hub as unknown as { router: { pid: number } }).router.pid
    process.kill(pid, 'SIGKILL')
    await until(() => !hub.running, 5000, 'router gone')
    await until(() => hub.running && hub.serving, 10_000, 'router back')
    let state: unknown = null
    for (let attempt = 0; attempt < 50 && state === null; attempt++) {
      state = await call(client('host'), 'getState').catch(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return null
      })
    }
    expect(state).toMatchObject({ status: 'stopped' })
  }, 30_000)

  it('hands the machine over to a newer Connector after its turns end', async () => {
    // The current owner: 3.0.0, its turns end shortly; it publishes how to reach it.
    await controller.shutdown()
    let turns = 1
    let handedOver = false
    const oldLease = lease('3.0.0')
    const old = makeController(oldLease, { handover: { version: '3.0.0', activeTurns: async () => turns, maxWaitMs: 10_000, onHandedOver: () => (handedOver = true) } })
    const oldHub = new LocalHub({ directory: join(dir, 'router'), binaryPath: binary! })
    await oldHub.start()
    await oldHub.mount(controlService(old, new ControlEvents()))
    try {
      await old.saveConfig(settings)
      await old.start()
      const unpublish = publishHandover(oldLease.instanceId, '3.0.0', oldHub.descriptor('handover'), join(dir, 'router'))
      // An older newcomer is told to use the existing one.
      const older = makeController(lease('2.9.9'), { handover: { version: '2.9.9', activeTurns: async () => 0, request: handoverRequester('2.9.9', join(dir, 'router')) } })
      await expect(older.acquireOwnership()).rejects.toMatchObject({ code: 'connector_already_running', decision: 'use_existing' })
      // A newer one asks; the owner waits for its turn, stops, releases and exits.
      const newer = makeController(lease('3.1.0'), { handover: { version: '3.1.0', activeTurns: async () => 0, request: handoverRequester('3.1.0', join(dir, 'router')) } })
      const claiming = newer.acquireOwnership()
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(handedOver).toBe(false)
      turns = 0
      await expect(claiming).resolves.toMatchObject({ status: 'stopped' })
      expect(handedOver).toBe(true)
      expect(old.getState()).toMatchObject({ running: false, lastError: 'handed over to Connector 3.1.0' })
      unpublish()
      await newer.shutdown()
    } finally {
      await oldHub.stop()
    }
  }, 40_000)
})
