// S6 device process: one DeviceLink in its own Node process, driven over IPC by test/link/s6.measure.test.ts, so
// its memory and CPU are not mixed with vitest, the fake Server or the Router client.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService } from '../../src/application/index.js'
import { ControlPlane, DeviceLink } from '../../src/link/index.js'
import { inProcessStore, openSqliteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed, OutboxSignal, plainSealer } from '../../src/sync/index.js'

interface Start {
  readonly serverUrl: string
  readonly deviceId: string
  readonly token: string
  readonly proxy: string | null
  readonly sessions: number
}

const send = (message: Record<string, unknown>): void => {
  process.send?.({ ...message, at: Date.now() })
}

let link: DeviceLink | null = null
const abort = new AbortController()
let dir = ''

async function start(options: Start): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'aa-s6-'))
  const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
  const store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  for (let index = 0; index < options.sessions; index++) {
    await store.sessions.create({ sessionId: `sess_${index}`, runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: `n_${index}`, cwd: '/w', nativeTitle: `T${index}`, status: 'idle', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
  }
  const feed = new MemoryChangeFeed()
  const service = new ConversationService({ store, feed, live: { emit: () => undefined }, runtimes: { handle: async () => null }, clock, ids: { newId: (prefix: string) => `${prefix}${Math.random().toString(36).slice(2)}` } })
  const outboxSignal = new OutboxSignal()
  const egress = () => ({ proxy: options.proxy, source: 's6' })
  send({ type: 'baseline', memory: process.memoryUsage(), cpu: process.cpuUsage() })
  if (process.env.AA_S6_NOLINK === '1') {
    // Control: the same process without the link, for the idle CPU floor.
    setTimeout(() => send({ type: 'state', state: 'online', connectionId: null }), 500)
    return
  }
  link = new DeviceLink({
    deviceId: options.deviceId,
    host: 'cli',
    handshake: new ControlPlane({ serverUrl: options.serverUrl, credential: () => ({ deviceId: options.deviceId, token: options.token }), egress, connectorVersion: '3.0.0-s6', os: process.platform }),
    store,
    inbox: new CommandInbox(store, clock, service),
    outboxSignal,
    services: {
      outbox: { outbox: store.outbox, sealer: plainSealer, signal: outboxSignal },
      watch: { store, feed, now: clock.nowIso },
      readers: new DeviceReaders(store, clock.nowIso),
    },
    egress,
    onState: state => send({ type: 'state', state, connectionId: link?.connectionId ?? null }),
    logger: { debug: () => undefined, info: text => send({ type: 'log', level: 'info', text }), warn: text => send({ type: 'log', level: 'warn', text }), error: text => send({ type: 'log', level: 'error', text }) },
  })
  void link.run(abort.signal).then(async () => {
    await service.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
    send({ type: 'stopped' })
  })
}

process.on('message', (message: { type: string } & Partial<Start>) => {
  if (message.type === 'start') void start(message as unknown as Start)
  else if (message.type === 'sample') send({ type: 'sample', memory: process.memoryUsage(), cpu: process.cpuUsage(), handles: (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.().length ?? null })
  else if (message.type === 'gc') {
    ;(globalThis as { gc?: () => void }).gc?.()
    send({ type: 'gc' })
  } else if (message.type === 'stop') abort.abort()
})
send({ type: 'ready' })
