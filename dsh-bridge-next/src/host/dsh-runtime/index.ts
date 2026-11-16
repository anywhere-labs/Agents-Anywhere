import type { BridgeStatus } from '../../contracts/bridge-status.js'
import { startupFailure, startupFailureDiagnostic } from './startup-status.js'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import { join } from 'node:path'
import { bridgeDirectory, Config, legacyBridgeDirectory } from '../config.js'
import { BridgeConnection } from './connection.js'
import { NativeRuntime } from './native.js'
import { RpcLogOutput } from './log-output.js'
import { readBridgeLogs, readConnectorRuntimeLogs } from './log-reader.js'
import type { ConnectorLogQuery, RuntimeLogPage, RuntimeLogQuery, StartupFailureDiagnostic } from '../../contracts/logs.js'
import { RuntimeDiagnostics } from './diagnostics.js'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { AcpBridgeLink, parseRendezvousV3, type LinkStatus } from '../acp/link.js'
import { detectHostKind } from '../acp/host-kind.js'
import { BRIDGE_VERSION, RUNTIME_VERSION } from './bridge-service.js'

const HOST_INSTANCE = Symbol.for('agents-anywhere.dsh-bridge.host-instance')

/** One ID per DSH host process; a plugin hot reload keeps it, so the Connector replaces the old connection (3.0 §1). */
function hostInstance(): string {
  const shared = globalThis as { [HOST_INSTANCE]?: string }
  return shared[HOST_INSTANCE] ??= `host_${randomBytes(12).toString('hex')}`
}

/** A v3 Connector publishes connector-acp.json; while one does, the 2.0 MeshCall link stays off (3.0 §1). */
function acpPublished(path: string): boolean {
  try { return parseRendezvousV3(readFileSync(path, 'utf8')) !== undefined } catch { return false }
}

declare module '@deepseek-ai/cordis' {
  interface Context { agentsAnywhereRuntime: DshRuntimeService }
}

/** Independent of OAuth, the modal, and Desktop installation detection. */
export class DshRuntimeService extends Service {
  static inject = ['sessions', 'sessionQuery', 'workspaceRegistry']
  static Config = Config
  private server: BridgeConnection
  /** dsh-bridge 3.0: ACP over the Connector's local socket. */
  readonly acp: AcpBridgeLink
  private legacyStopped = false
  private readonly makeServer: () => BridgeConnection
  private restartTask: Promise<BridgeStatus> | undefined
  private disposed = false
  private currentStatus: BridgeStatus = { state: 'starting', message: '正在启动本机连接…', hint: '', canRetry: false }
  status(): BridgeStatus { return { ...this.currentStatus } }
  private startupFailureSnapshot: StartupFailureDiagnostic | null = null
  startupDiagnostic(): StartupFailureDiagnostic | null {
    return this.startupFailureSnapshot && { ...this.startupFailureSnapshot }
  }
  private readonly diagnostics: RuntimeDiagnostics
  private readonly logOutput = new RpcLogOutput()
  readonly native: NativeRuntime

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereRuntime')
    const bridge = bridgeDirectory()
    const legacy = legacyBridgeDirectory(config)
    this.diagnostics = new RuntimeDiagnostics(this.logOutput)
    this.native = new NativeRuntime(ctx, join(bridge, 'create-intents'), this.diagnostics,
      legacy && join(legacy, 'attachments', 'staging'))
    // The Connector publishes its Router in connector.json; the plugin registers the Bridge on it.
    this.makeServer = () => new BridgeConnection(join(bridge, 'connector.json'), {
      native: this.native,
      query: { listSessions: signal => this.native.inventory(signal), readSession: id => this.native.read(id),
        readTitleSnapshots: async (ids, signal) => {
          const results: Awaited<ReturnType<typeof ctx.sessionQuery.readTitleSnapshots>> = []
          for (const id of new Set(ids)) {
            signal?.throwIfAborted()
            try {
              const log = await this.native.source.readLog(id)
              const title = foldSessionTitle(log.events)
              results.push({ sessionId: id, status: 'fulfilled', value: { session: log.session, ...(title ? { title } : {}) } })
            } catch (reason) { results.push({ sessionId: id, status: 'rejected', reason }) }
          }
          signal?.throwIfAborted()
          return results
        } },
      status: id => this.native.status(id),
    }, this.diagnostics, 1000, this.logOutput)
    this.server = this.makeServer()
    const acpPath = join(bridge, 'connector-acp.json')
    this.acp = new AcpBridgeLink(acpPath, this.native, { hostInstance: hostInstance(), hostKind: detectHostKind(),
      dshVersion: RUNTIME_VERSION, pluginVersion: BRIDGE_VERSION, dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
      uploadRoot: dirname(bridge) }, 1000, status => this.onAcpStatus(status))
    this.acpPath = acpPath
    ctx.effect(() => async () => {
      this.disposed = true
      await this.restartTask
      try { await this.acp.close(); await this.native.close() }
      finally { await this.server.close(); await this.diagnostics.flush() }
    }, 'agentsAnywhereRuntime.close')
  }

  private readonly acpPath: string

  async [Service.init](): Promise<void> {
    await this.restart()
    this.acp.start()
  }

  /** Follow the 3.0 rendezvous: a v3 Connector takes over from the 2.0 link, and gives it back when it goes away. */
  private onAcpStatus(status: LinkStatus): void {
    if (this.disposed) return
    if (status.state === 'connected' && !this.legacyStopped) {
      this.legacyStopped = true
      void this.server.close().catch(() => undefined)
      this.currentStatus = { state: 'ready', message: '本机连接已就绪', hint: '', canRetry: false }
    } else if (status.state === 'waiting' && this.legacyStopped) {
      this.legacyStopped = false
      void this.restart()
    }
  }

  hasLogConnection(): boolean { return Boolean(this.server.connectorInstance) }
  get logsPath(): string | null { return this.server.logsPath }

  async readRuntimeLogs(query?: RuntimeLogQuery, extraOutput?: RpcLogOutput): Promise<RuntimeLogPage> {
    if (!this.hasLogConnection()) {
      return {
        available: false,
        items: [],
        firstSeq: null,
        lastSeq: null,
        total: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        logsPath: this.server.logsPath,
        updatedAt: new Date().toISOString(),
      }
    }
    return this.server.readRuntimeLogs(query, extraOutput)
  }

  async readBridgeLogs() {
    if (!this.hasLogConnection()) return { entries: [], updatedAt: new Date().toISOString() }
    return readBridgeLogs(await this.server.readLogs('bridge'))
  }
  async readConnectorLogs(query?: ConnectorLogQuery) {
    return readConnectorRuntimeLogs(await this.server.readLogs('connector', query?.before, query?.after))
  }

  restart(): Promise<BridgeStatus> {
    if (this.restartTask) return this.restartTask
    if (this.disposed) return Promise.resolve({ state: 'unavailable', message: '本机连接已关闭。',
      hint: '请重新加载插件后再试。', canRetry: false })
    this.currentStatus = { state: 'starting', message: '正在启动本机连接…', hint: '', canRetry: false }
    this.restartTask = (async () => {
      try {
        await this.server.close()
        if (this.disposed) return this.status()
        this.server = this.makeServer()
        await this.native.attachments.initialize()
        if (acpPublished(this.acpPath)) this.legacyStopped = true
        else await this.server.start()
        this.currentStatus = { state: 'ready', message: '本机连接已就绪', hint: '', canRetry: false }
        this.startupFailureSnapshot = null
      } catch (error) {
        this.currentStatus = startupFailure(error)
        this.startupFailureSnapshot = startupFailureDiagnostic(error, 'bridge', 'bridge.restart_failed', this.currentStatus)
        this.diagnostics.log('error', 'bridge.restart_failed', { code: this.currentStatus.code }, error)
      }
      return this.status()
    })().finally(() => { this.restartTask = undefined })
    return this.restartTask
  }

}
