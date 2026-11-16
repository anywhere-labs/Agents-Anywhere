import { join } from 'node:path'

import {
  ConfigFile,
  ConnectorController,
  ControlEvents,
  LocalHub,
  LogStore,
  RuntimeLease,
  controlService,
  dataDir,
  defaultConfigPath,
  handoverRequester,
  logsService,
  publishHandover,
  routerDirectory,
  runtimeRecordPath,
  systemHome,
  type FetchJson,
  type HostKind,
  type LocalDescriptor,
} from '../host/index.js'
import { readSystemProxySettings, requestJson, resolveEgress } from '../link/index.js'
import type { RemoteStore } from '../store/index.js'
import { SCHEMA_VERSION } from '../store/index.js'
import { activeTurns, connectorRuntime, type ComposeOptions, type Log } from './compose.js'

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
  shutdown(): Promise<void>
}

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
  const hub = new LocalHub({ directory: routerDir, ...(options.routerBinary !== undefined ? { binaryPath: options.routerBinary } : {}), onLog: log })
  const controller = new ConnectorController({
    config: new ConfigFile(options.configPath ?? (options.home !== undefined ? join(dir, 'connector.json') : defaultConfigPath())),
    lease,
    runtimePath: runtimeRecordPath(home),
    runtime: connectorRuntime({ ...options.compose, dataDir: dir, host: COMPOSE_HOST[options.kind], connectorVersion: CONNECTOR_VERSION, log }, { store: value => (store = value) }),
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
  await hub.mount(controlService(controller, events), logsService(logs))
  const unpublish = publishHandover(lease.instanceId, CONNECTOR_VERSION, hub.descriptor('handover'), routerDir)
  log('info', `connector ${CONNECTOR_VERSION} (${options.kind}) serving local control at ${JSON.stringify(hub.endpoint)}`)
  let closing: Promise<void> | null = null
  return {
    controller,
    events,
    hub,
    logs,
    log,
    descriptor: hub.descriptor('host'),
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
