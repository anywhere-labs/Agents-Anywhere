import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Mesh, Router, type RunningServer } from 'meshcall'
import type { RuntimeLogPage, RuntimeLogQuery } from '../../contracts/logs.js'
import { LogsServiceClient, type LogPage } from '../generated/connector-logs.js'
import { RuntimeRpcLogger } from './diagnostics.js'
import { RpcLogOutput } from './log-output.js'
import { readRuntimeLogPage } from './log-reader.js'
import { SyncServiceClient, type CheckpointResult, type SnapshotPage, type SnapshotRequest, type SnapshotResult, type SyncBatch as WireBatch } from '../generated/dsh-sync.js'
import { acquireManagerLock } from '../storage/files.js'
import { BridgeService } from './bridge-service.js'
import { quietDiagnostics, type RuntimeDiagnostics } from './diagnostics.js'
import type { SessionReader } from './router.js'
import type { SyncCheckpoint, SyncTransport } from './sync.js'
import { record } from './types.js'

/** What the Connector publishes for this plugin (contracts/dsh-bridge/2.0). */
export interface Rendezvous {
  version: 2
  protocol: 'meshcall'
  instanceId: string
  pid: number
  endpoint: { unixPath: string } | { pipe: string }
  key: string
}

export function parseRendezvous(text: string): Rendezvous | undefined {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(text)) } catch { return undefined }
  const endpoint = record(value.endpoint)
  const local = typeof endpoint.unixPath === 'string' && endpoint.unixPath ? { unixPath: endpoint.unixPath }
    : typeof endpoint.pipe === "string" && endpoint.pipe ? { pipe: endpoint.pipe } : undefined
  if (value.version !== 2 || value.protocol !== 'meshcall' || !local || typeof value.instanceId !== 'string' || !value.instanceId
    || typeof value.key !== 'string' || !value.key.startsWith('mk_') || typeof value.pid !== 'number') return undefined
  return { version: 2, protocol: 'meshcall', instanceId: value.instanceId, pid: value.pid, endpoint: local, key: value.key }
}

/**
 * The Connector's `aa.dsh.v2.Sync`, one call per batch or checkpoint.
 * It is the plugin's half of a subscription: the SyncFeed sends batches here.
 */
export class ConnectorSync implements SyncTransport {
  constructor(private readonly client: SyncServiceClient, private readonly subscriptionId: string) {}

  async ingestBatch(batch: WireBatch, signal: AbortSignal): Promise<void> {
    // The key lets the Router dedupe a retried delivery of the same batch.
    await this.client.ingestBatch(batch, { signal, idempotencyKey: `dsh-${batch.subscriptionId}-${batch.batchSeq}`.slice(0, 128) })
  }

  async loadCheckpoint(externalSessionId: string): Promise<Record<string, unknown> | null> {
    const result: CheckpointResult = await this.client.loadCheckpoint(this.subscriptionId, externalSessionId)
    return result.checkpoint ?? null
  }

  async saveCheckpoint(externalSessionId: string, checkpoint: SyncCheckpoint): Promise<void> {
    await this.client.saveCheckpoint(this.subscriptionId, externalSessionId, checkpoint as unknown as Record<string, unknown>)
  }

  async deleteCheckpoint(externalSessionId: string): Promise<void> {
    await this.client.deleteCheckpoint(this.subscriptionId, externalSessionId)
  }

  async ingestSnapshot(request: SnapshotRequest, pages: AsyncIterable<SnapshotPage>, signal: AbortSignal): Promise<SnapshotResult> {
    return this.client.ingestSnapshot(request, pages, { signal })
  }
}

interface Link { rendezvous: Rendezvous, mesh: Mesh, server: RunningServer, sync: SyncServiceClient, logs: LogsServiceClient }

/**
 * Serves `aa.dsh.v2.Bridge` on the Router of whichever Connector currently
 * publishes the rendezvous, and follows it when that Connector is replaced.
 * The manager lock keeps a second plugin instance from registering beside us,
 * which would split the Connector's calls between two DSH processes.
 */
export class BridgeConnection {
  private readonly service: BridgeService
  private link: Link | undefined
  private releaseLease: (() => Promise<void>) | undefined
  private startTask: Promise<void> | undefined
  private checking: Promise<void> | undefined
  private recheck = false
  private timer: NodeJS.Timeout | undefined
  private watcher: FSWatcher | undefined
  private lastFailure: string | undefined
  private closed = false
  private closeTask: Promise<void> | undefined

  constructor(readonly rendezvousPath: string, reader: SessionReader,
    private readonly diagnostics: RuntimeDiagnostics = reader.native?.diagnostics ?? quietDiagnostics,
    private readonly pollMs = 1000, private readonly logOutput?: RpcLogOutput) {
    this.service = new BridgeService({ reader, diagnostics,
      transportFor: subscriptionId => new ConnectorSync(this.requireLink().sync, subscriptionId) })
  }

  private cachedLogsPath: string | null = null

  /** The Connector this plugin serves right now, if any. */
  get connectorInstance(): string | undefined { return this.link?.rendezvous.instanceId }
  get logsPath(): string | null { return this.cachedLogsPath }

  async readRuntimeLogs(query?: RuntimeLogQuery, extraOutput?: RpcLogOutput): Promise<RuntimeLogPage> {
    const link = this.requireLink()
    await this.logOutput?.flush()
    await extraOutput?.flush(link.logs)
    return readRuntimeLogPage(link.logs, query, this.logsPath)
  }

  async readLogs(
    source: 'connector' | 'bridge' | null = null,
    before?: number | null,
    after?: number | null,
    limit = 200,
    extraOutput?: RpcLogOutput,
  ): Promise<LogPage> {
    const link = this.requireLink()
    await this.logOutput?.flush()
    await extraOutput?.flush(link.logs)
    return link.logs.read(source, before ?? null, after ?? null, limit, { timeoutMs: 3000 })
  }

  start(): Promise<void> {
    if (!this.startTask) {
      const task = this.open()
      this.startTask = task
      void task.catch(() => { if (!this.closed && this.startTask === task) this.startTask = undefined })
    }
    return this.startTask
  }

  private requireLink(): Link {
    if (!this.link) throw new Error('No Connector is serving DSH sync')
    return this.link
  }

  private async open(): Promise<void> {
    if (this.closed) throw new Error('DSH bridge is closed')
    this.releaseLease = await acquireManagerLock(this.rendezvousPath, () => {
      this.diagnostics.log('error', 'bridge.lease_lost', {})
      void this.close()
    })
    if (this.closed) { await this.releaseLease(); return }
    this.timer = setInterval(() => this.check(), this.pollMs)
    this.timer.unref()
    try {
      const name = basename(this.rendezvousPath)
      this.watcher = watch(dirname(this.rendezvousPath), (_event, file) => { if (!file || String(file) === name) this.check() })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
    } catch { /* polling alone still follows the Connector */ }
    this.check()
    await this.checking
  }

  /** Serialised: one reconciliation at a time, and one more if asked meanwhile. */
  private check(): void {
    if (this.closed) return
    if (this.checking) { this.recheck = true; return }
    this.checking = this.reconcile().catch(error => {
      this.failed('bridge.reconcile_failed', error)
    }).finally(() => {
      this.checking = undefined
      if (this.recheck && !this.closed) { this.recheck = false; this.check() }
    })
  }

  private async reconcile(): Promise<void> {
    let rendezvous: Rendezvous | undefined
    try { rendezvous = parseRendezvous(await readFile(this.rendezvousPath, 'utf8')) }
    catch (error) { if (record(error).code !== 'ENOENT') this.failed('bridge.rendezvous_unreadable', error) }
    const current = this.link?.rendezvous
    if (current && rendezvous && current.instanceId === rendezvous.instanceId && current.key === rendezvous.key) {
      await this.logOutput?.flush()
      return
    }
    if (this.link) await this.disconnect()
    if (!rendezvous || this.closed) return
    const router = new Router('unixPath' in rendezvous.endpoint ? { unixPath: rendezvous.endpoint.unixPath } : { pipe: rendezvous.endpoint.pipe })
    const rpcLogger = new RuntimeRpcLogger(this.diagnostics)
    const mesh = new Mesh(router, { token: rendezvous.key, peerId: `dsh-bridge-${randomUUID()}`, logger: rpcLogger })
    mesh.mount(this.service, { instanceId: `dsh-bridge-${randomUUID()}` })
    let server: RunningServer
    try { server = await mesh.startServing({ logLevel: 'debug', logger: rpcLogger }) }
    catch (error) {
      // A Connector that died without unpublishing; the next one replaces the file.
      await mesh.close().catch(() => undefined)
      this.failed('bridge.connector_unreachable', error, { connector: rendezvous.instanceId })
      return
    }
    if (this.closed) { await mesh.close(); return }
    this.link = { rendezvous, mesh, server, sync: new SyncServiceClient(mesh), logs: new LogsServiceClient(mesh) }
    this.cachedLogsPath = join(dirname(dirname(this.rendezvousPath)), 'logs')
    this.logOutput?.connect(this.link.logs)
    this.lastFailure = undefined
    this.diagnostics.log('info', 'bridge.connected', { connector: rendezvous.instanceId, connectorPid: rendezvous.pid })
    await this.logOutput?.flush()
  }

  private failed(event: string, error: unknown, details: Record<string, string> = {}): void {
    const key = `${event}:${error instanceof Error ? error.message : String(error)}`
    if (key === this.lastFailure) return
    this.lastFailure = key
    this.diagnostics.log('warn', event, details, error)
  }

  private async disconnect(): Promise<void> {
    const link = this.link
    if (!link) return
    this.service.close()
    this.diagnostics.log('info', 'bridge.disconnected', { connector: link.rendezvous.instanceId })
    await this.logOutput?.flush()
    this.logOutput?.connect(undefined)
    this.link = undefined
    // Streams end with the router shutdown above; the timeout is a last resort.
    await link.server.close({ drain: true, drainTimeoutMs: 1_000 }).catch(() => undefined)
    await link.mesh.close().catch(() => undefined)
  }

  close(): Promise<void> {
    // Idempotent and awaitable: a second caller waits for the same cleanup.
    return this.closeTask ??= this.closing()
  }

  private async closing(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    await this.startTask?.catch(() => undefined)
    await this.checking
    await this.disconnect()
    const release = this.releaseLease
    this.releaseLease = undefined
    await release?.()
  }
}

