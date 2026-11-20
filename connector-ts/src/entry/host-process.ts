import { join } from 'node:path'

import {
  agentsAnywhereHome,
  ConfigFile,
  ConnectorController,
  ControlEvents,
  LocalConfirmations,
  LocalHub,
  LogStore,
  RuntimeLease,
  controlService,
  dataDir,
  legacyDataDir,
  defaultConfigPath,
  handoverRequester,
  logsService,
  publishClientPairing,
  publishClientAdmin,
  publishHandover,
  routerDirectory,
  runtimeRecordPath,
  systemHome,
  type ClientPairingInvitation,
  type ClientTrustControl,
  type FetchJson,
  type HostKind,
  type LocalDescriptor,
} from '../host/index.js'
import { readSystemProxySettings, requestJson, resolveEgress } from '../link/index.js'
import type { RemoteStore } from '../store/index.js'
import { SCHEMA_VERSION } from '../store/index.js'
import { activeTurns, connectorRuntime, type ComposeOptions, type Log } from './compose.js'
import type { DeviceTrust } from './trust.js'

/** This build's Connector version (package metadata is not readable from a single-file build). */
export const CONNECTOR_VERSION = process.env.AA_CONNECTOR_VERSION ?? '3.0.0-dev'

export interface HostProcessOptions {
  readonly kind: HostKind
  /** The OS user's home; tests pass a temporary one (never from the environment: the mutex must not move). */
  readonly home?: string
  readonly configPath?: string
  readonly debug?: boolean
  /** The local Router binary (default `MESHCALL_ROUTER_BINARY`, then meshcall's lookup). */
  readonly routerBinary?: string
  readonly compose?: Partial<Omit<ComposeOptions, 'dataDir' | 'host' | 'connectorVersion' | 'log'>>
  /** Echo log lines somewhere besides the log store (the CLI's stderr). */
  readonly echo?: (level: string, message: string) => void
  /** The handover finished: the process should exit. */
  readonly onHandedOver?: () => void
}

export interface HostProcess {
  readonly controller: ConnectorController
  readonly events: ControlEvents
  readonly hub: LocalHub
  readonly logs: LogStore
  readonly log: Log
  /** What the host needs to reach this Connector's control channel (`host` role). */
  readonly descriptor: LocalDescriptor
  /** Where Device Trust asks the person at this computer (the CLI registers its terminal here). */
  readonly confirmations: LocalConfirmations
  /** A client pairing invitation of the running Connector (also `Control/startClientPairing`). */
  startClientPairing(): Promise<ClientPairingInvitation>
  shutdown(): Promise<void>
}

/** How long a pairing request waits for a just-started runtime to open Device Trust. */
const TRUST_WAIT_MS = 20_000

const COMPOSE_HOST: Record<HostKind, ComposeOptions['host']> = { cli: 'cli', 'desktop-workbench': 'desktop', 'dsh-plugin': 'dsh-plugin' }

/** JSON over the Connector's egress (proxy and system CAs), for pairing and health checks. */
export const fetchJsonViaEgress: FetchJson = async (method, url, body, options = {}) => {
  // HttpError carries `status`, which the pairing code reads.
  const egress = await resolveEgress(url, { system: await readSystemProxySettings() })
  return requestJson(() => egress, { method, url: new URL(url), ...(body !== undefined ? { body } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.signal !== undefined ? { signal: options.signal } : {}) })
}

/**
 * Everything a Connector process runs besides its configured runtime (`anywhere-cli rpc`, `start`, Desktop's
 * utility process): the log store, the machine lease, the controller, the local Router with `aa.local.v2.Control`
 * and `Logs`, and the handover rendezvous for a newer Connector.
 */
export async function startHostProcess(options: HostProcessOptions): Promise<HostProcess> {
  const home = options.home ?? systemHome()
  const dir = dataDir(process.env, home)
  const routerDir = routerDirectory(home)
  const logs = await LogStore.open(join(dir, 'logs'))
  const log: Log = (level, message) => {
    if (level === 'debug' && options.debug !== true) return
    options.echo?.(level, message)
    void logs.append([{ time: new Date().toISOString(), level: level.toUpperCase(), name: 'connector', message }], 'connector', false).catch(() => undefined)
  }
  const events = new ControlEvents()
  const lease = new RuntimeLease({ path: runtimeRecordPath(home), identity: { kind: options.kind, version: CONNECTOR_VERSION, schemaVersion: SCHEMA_VERSION } })
  let store: RemoteStore | null = null
  let trust: DeviceTrust | null = null
  const trustWaiters = new Set<() => void>()
  const confirmations = new LocalConfirmations()
  /** The running Connector's Device Trust; a runtime that just started opens it shortly (bounded wait). */
  const running = async (): Promise<DeviceTrust> => {
    const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })
    if (options.compose?.trust === false) throw fail('not_available', 'end-to-end encryption is off in this Connector')
    const deadline = Date.now() + TRUST_WAIT_MS
    while (trust === null) {
      if (!controller.getState().running) throw fail('connector_not_running', 'the Connector is not running; start it first')
      if (Date.now() >= deadline) throw fail('connector_offline', 'the Connector has not finished starting; try again')
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, 250)
        function done(): void {
          clearTimeout(timer)
          trustWaiters.delete(done)
          resolve()
        }
        trustWaiters.add(done)
      })
    }
    return trust
  }
  const clientTrust: ClientTrustControl = {
    startClientPairing: async () => (await running()).invite(),
    startMobilePairing: async () => (await running()).invite(undefined, true),
    clientPairingStatus: async id => (await running()).trust.pairingStatus(id),
    listClientGrants: async () => (await running()).trust.trustList(),
    revokeClientGrant: async ({ deviceId, clientId, grantedAt }) => {
      const { trust } = await running()
      if (trust.state.deviceId !== deviceId) throw new Error('The selected device has changed')
      await trust.revokeClient(clientId, grantedAt)
      return trust.trustList()
    },
    grantLocalClient: async request => (await running()).grantLocal(request),
  }
  // Every approval is confirmed here unless a test supplies its own confirmation.
  const composeTrust: ComposeOptions['trust'] = options.compose?.trust === false ? false : { confirmation: confirmations, ...options.compose?.trust }
  const hub = new LocalHub({ directory: routerDir, ...(options.routerBinary !== undefined ? { binaryPath: options.routerBinary } : {}), onLog: log })
  const controller = new ConnectorController({
    config: new ConfigFile(options.configPath ?? (options.home !== undefined ? join(dir, 'connector.json') : defaultConfigPath())),
    lease,
    runtimePath: runtimeRecordPath(home),
    runtime: connectorRuntime({ legacyDataDir: legacyDataDir(process.env, home), dshHosts: { dir: join(agentsAnywhereHome(home), 'dsh-bridge'), instanceId: lease.instanceId }, ...options.compose, trust: composeTrust, dataDir: dir, host: COMPOSE_HOST[options.kind], connectorVersion: CONNECTOR_VERSION, log }, {
      store: value => (store = value),
      trust: value => {
        trust = value
        for (const wake of [...trustWaiters]) wake()
      },
    }),
    fetchJson: fetchJsonViaEgress,
    notify: (kind, payload) => events.publish(kind, payload),
    handover: {
      version: CONNECTOR_VERSION,
      activeTurns: async () => (store === null ? 0 : activeTurns(store)),
      request: handoverRequester(CONNECTOR_VERSION, routerDir, message => log('info', message)),
      ...(options.onHandedOver !== undefined ? { onHandedOver: options.onHandedOver } : {}),
    },
    log,
  })
  await hub.start()
  await hub.mount(controlService(controller, events, { trust: clientTrust, confirmations }), logsService(logs))
  const unpublishHandover = publishHandover(lease.instanceId, CONNECTOR_VERSION, hub.descriptor('handover'), routerDir)
  const unpublishPairing = publishClientPairing(lease.instanceId, CONNECTOR_VERSION, hub.descriptor('client-pairing'), routerDir)
  const unpublishAdmin = publishClientAdmin(lease.instanceId, CONNECTOR_VERSION, hub.descriptor('client-admin'), routerDir)
  const unpublish = (): void => {
    unpublishAdmin()
    unpublishHandover()
    unpublishPairing()
  }
  log('info', `connector ${CONNECTOR_VERSION} (${options.kind}) serving local control at ${JSON.stringify(hub.endpoint)}`)
  let closing: Promise<void> | null = null
  return {
    controller,
    events,
    hub,
    logs,
    log,
    descriptor: hub.descriptor('host'),
    confirmations,
    startClientPairing: () => clientTrust.startClientPairing(),
    shutdown: () => {
      closing ??= (async () => {
        try {
          await controller.shutdown()
        } finally {
          unpublish()
          await hub.stop().catch(() => undefined)
          await logs.close().catch(() => undefined)
        }
      })()
      return closing
    },
  }
}
