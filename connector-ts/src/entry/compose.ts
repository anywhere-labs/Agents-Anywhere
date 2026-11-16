import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { CommandInbox, type CommandHandler } from '../application/inbound/index.js'
import { ConversationService } from '../application/index.js'
import type { LiveEvents, RuntimeHandles } from '../application/ports/index.js'
import type { ConnectorRuntime, ConnectorSettings, RuntimeFactory } from '../host/index.js'
import { ControlPlane, DeviceLink, readSystemProxySettings, resolveEgress, type Egress, type LinkLogger, type SecureChannelHandler } from '../link/index.js'
import { openStoreWorker, inProcessStore, openSqliteStore, type RemoteStore } from '../store/index.js'
import { DeviceReaders, MemoryChangeFeed, OutboxSignal, plainSealer, type DisplaySealer } from '../sync/index.js'

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

export interface ComposeOptions {
  readonly dataDir: string
  readonly host: 'desktop' | 'cli' | 'dsh-plugin'
  readonly connectorVersion: string
  readonly log: Log
  /** The Runtime providers (B's `runtime/`); none means sessions cannot open yet. */
  readonly runtimes?: RuntimeHandles
  /** Extra command handlers (preview, runtime/apply, device settings), by business method name. */
  readonly commands?: Readonly<Record<string, CommandHandler>>
  /** F's display sealer for encrypted mode; plain by default. */
  readonly sealer?: DisplaySealer
  /** F's `Secure/channel` handler (`secureChannelVia(hub)`), registered in encrypted mode. */
  readonly secure?: SecureChannelHandler
  /** The store in a worker thread (production) or in this thread (tests, tools). */
  readonly storeMode?: 'worker' | 'in-process'
  /** Told when a link exists (the host wires port events and other live sources to `link.attach`). */
  readonly onLink?: (link: DeviceLink) => void
}

const NO_RUNTIMES: RuntimeHandles = { handle: async () => null }
const EGRESS_REFRESH_MS = 60_000

const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
const ids = { newId: (prefix: string) => `${prefix}${randomBytes(12).toString('base64url')}` }

/** The route to the Server, re-read every minute so switching a system proxy on or off needs no restart. */
async function egressFor(settings: ConnectorSettings, signal: AbortSignal, log: Log): Promise<() => Egress> {
  const resolveNow = async (): Promise<Egress> => resolveEgress(settings.serverUrl, { configured: settings.proxy ?? null, system: await readSystemProxySettings() })
  let current = await resolveNow()
  log('info', `network egress: ${current.proxy === null ? 'direct' : 'proxy'} (${current.source})`)
  const timer = setInterval(() => {
    resolveNow().then(next => {
      if (next.proxy !== current.proxy) log('info', `network egress changed: ${next.proxy === null ? 'direct' : 'proxy'} (${next.source})`)
      current = next
    }, () => undefined)
  }, EGRESS_REFRESH_MS)
  timer.unref()
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return () => current
}

/** Turns from `turn.started` to `turn.ended` on this device (a handover waits for zero). */
export async function activeTurns(store: RemoteStore): Promise<number> {
  return (await store.sessions.list()).filter(session => session.activeTurn !== null).length
}

/**
 * The composition root of a configured Connector (04-connector.md §2): the local store, the use cases, the device
 * link and the Runtime providers, wired once per `start`. Everything else in `entry/` is process plumbing.
 */
export function connectorRuntime(options: ComposeOptions, track?: { store(store: RemoteStore | null): void }): RuntimeFactory {
  return (settings, hooks): ConnectorRuntime => ({
    async run(signal) {
      const storeOptions = { dataDir: join(options.dataDir, 'store'), durability: 'normal' as const, now: clock.nowIso }
      const store = options.storeMode === 'in-process' ? inProcessStore(openSqliteStore(storeOptions)) : await openStoreWorker(storeOptions)
      track?.store(store)
      let link: DeviceLink | null = null
      const live: LiveEvents = { emit: (method, payload) => link?.attach.emit(method, payload) }
      const feed = new MemoryChangeFeed()
      const service = new ConversationService({ store, feed, live, runtimes: options.runtimes ?? NO_RUNTIMES, clock, ids })
      try {
        const egress = await egressFor(settings, signal, options.log)
        const inbox = new CommandInbox(store, clock, service, options.commands ?? {})
        const outboxSignal = new OutboxSignal()
        const logger: LinkLogger = {
          debug: text => options.log('debug', text),
          info: text => options.log('info', text),
          warn: text => options.log('warn', text),
          error: text => options.log('error', text),
        }
        link = new DeviceLink({
          deviceId: settings.connectorId,
          host: options.host,
          handshake: new ControlPlane({
            serverUrl: settings.serverUrl,
            credential: () => ({ deviceId: settings.connectorId, token: settings.connectorToken }),
            egress,
            connectorVersion: options.connectorVersion,
            os: process.platform,
          }),
          store,
          inbox,
          outboxSignal,
          services: {
            outbox: { outbox: store.outbox, sealer: options.sealer ?? plainSealer, signal: outboxSignal },
            watch: { store, feed, now: clock.nowIso },
            readers: new DeviceReaders(store, clock.nowIso),
            ...(options.secure !== undefined ? { secure: options.secure } : {}),
          },
          egress,
          logger,
          onWelcome: welcome => {
            const settingsFromServer = welcome.desired?.deviceSettings
            if (settingsFromServer !== undefined && settingsFromServer !== null) hooks.deviceSettings(settingsFromServer)
          },
          onState: state => options.log('info', `device link ${state}`),
        })
        options.onLink?.(link)
        await link.run(signal)
      } finally {
        await service.close().catch(() => undefined)
        track?.store(null)
        await store.close().catch(() => undefined)
      }
    },
  })
}
