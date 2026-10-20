import type { BridgeStatus } from '../../contracts/bridge-status.js'
import { onboardingDiagnostics } from '../onboarding/diagnostics.js'
import type { RuntimeDiagnostics } from '../dsh-runtime/diagnostics.js'
import { RpcLogOutput } from '../dsh-runtime/log-output.js'
import { startupFailure, unavailableBridge } from '../dsh-runtime/startup-status.js'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HOST_NAMESPACE, type DesktopLaunch, type DeviceRecoveryAction, type DeviceRecoveryResult, type LoginRequest, type OnboardingHostApi, type OnboardingSnapshot } from '../../contracts/index.js'
import { Config, resolveConfig } from '../config.js'
import { OnboardingManager } from '../onboarding/manager.js'
import type {} from '../dsh-runtime/index.js'
import type { ConnectorAction, ConnectorFolder, ConnectorSettings } from '../../contracts/connector.js'
import type { MobileLoginSnapshot } from '../../contracts/mobile.js'
import { join } from 'node:path'
import { stateRoot } from '../config.js'
import { readConnectorLogs } from '../connector/logs.js'
import type { ConnectorLogPage, ConnectorLogQuery, BridgeLogSnapshot, RuntimeLogPage, RuntimeLogQuery } from '../../contracts/logs.js'

declare module '@deepseek-ai/cordis' {
  interface Context { agentsAnywhereOnboarding: OnboardingService }
}

/** Uses the rc.1 public Typert Gateway; no Desktop IPC or DSH Agent services. */
export class OnboardingService extends TypertRemoteService implements OnboardingHostApi {
  static Config = Config
  private manager: OnboardingManager
  private readonly makeManager: () => OnboardingManager
  private managerFailure: BridgeStatus | null = null
  private recovery: Promise<BridgeStatus> | undefined
  private disposed = false
  private readonly pluginLogOutput = new RpcLogOutput(512, 'plugin')
  private readonly diagnostics: RuntimeDiagnostics
  private readonly logsDirectory: string

  constructor(ctx: Context, config: Config) {
    super(ctx, HOST_NAMESPACE)
    this.logsDirectory = join(stateRoot(config), 'logs')
    this.diagnostics = onboardingDiagnostics(ctx.logger('agents-anywhere-onboarding'), this.logsDirectory, this.pluginLogOutput)
    this.makeManager = () => new OnboardingManager(resolveConfig(config), {
      diagnostics: this.diagnostics,
      logOutput: this.pluginLogOutput,
    })
    this.manager = this.makeManager()
    ctx.effect(() => async () => {
      this.disposed = true
      await this.recovery
      await this.manager.dispose()
      await this.diagnostics.flush()
    }, 'agentsAnywhereOnboarding.dispose')
  }

  async [Service.init](): Promise<void> {
    try { await this.manager.initialize(); this.managerFailure = null }
    catch (error) {
      this.managerFailure = startupFailure(error)
      this.diagnostics.log('error', 'onboarding.start_failed', { code: this.managerFailure.code }, error)
      return
    }
    // Restoring an authorized connection must not prevent the settings page
    // from mounting while uv prepares its environment.
    void this.manager.resume().catch(() => undefined)
  }

  @Remote('inspect')
  async inspect(): Promise<OnboardingSnapshot> {
    if (this.managerFailure) return { ...this.manager.unavailableSnapshot(this.managerFailure.message), bridge: this.managerFailure }
    const snapshot = await this.manager.inspect()
    const runtime = this.ctx.get('agentsAnywhereRuntime')
    const logsPath = snapshot.connector.logsPath || runtime?.logsPath || ''
    return {
      ...snapshot,
      connector: { ...snapshot.connector, logsPath },
      bridge: runtime?.status() ?? unavailableBridge,
    }
  }
  @Remote('restartBridge')
  restartBridge(): Promise<BridgeStatus> {
    if (this.recovery) return this.recovery
    this.recovery = (async () => {
      if (this.managerFailure) {
        await this.manager.dispose()
        if (this.disposed) return unavailableBridge
        this.manager = this.makeManager()
        await this[Service.init]()
        if (this.managerFailure) return this.managerFailure
      }
      return this.ctx.get('agentsAnywhereRuntime')?.restart() ?? unavailableBridge
    })().finally(() => { this.recovery = undefined })
    return this.recovery
  }
  @Remote('openDesktop')
  openDesktop(): Promise<DesktopLaunch> { return this.manager.openDesktop() }
  @Remote('readRuntimeLogs')
  async readRuntimeLogs(query?: RuntimeLogQuery): Promise<RuntimeLogPage> {
    const runtime = this.ctx.get('agentsAnywhereRuntime')
    if (this.manager.hasRuntimeLogs()) {
      return this.manager.readRuntimeLogs(query)
    }
    if (runtime?.hasLogConnection()) {
      return runtime.readRuntimeLogs(query, this.pluginLogOutput)
    }
    return {
      available: false,
      items: [],
      firstSeq: null,
      lastSeq: null,
      total: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      logsPath: this.manager.logsPath ?? runtime?.logsPath ?? null,
      updatedAt: new Date().toISOString(),
    }
  }
  @Remote('readBridgeLogs')
  async readBridgeLogs(): Promise<BridgeLogSnapshot> {
    const runtime = this.ctx.get('agentsAnywhereRuntime')
    if (runtime?.hasLogConnection()) return runtime.readBridgeLogs()
    if (this.manager.hasRuntimeLogs()) {
      const page = await this.manager.readRuntimeLogs({ source: 'bridge' })
      return {
        entries: page.items.map(item => ({
          id: String(item.seq),
          time: item.time,
          level: item.level,
          event: item.message,
          details: item.details ?? '{}',
          ...(item.method ? { method: item.method } : {}),
          ...(item.outcome ? { outcome: item.outcome } : {}),
        })),
        updatedAt: page.updatedAt,
      }
    }
    return { entries: [], updatedAt: new Date().toISOString() }
  }
  @Remote('readConnectorLogs')
  readConnectorLogs(query?: ConnectorLogQuery): Promise<ConnectorLogPage> {
    return readConnectorLogs(this.logsDirectory, query)
  }
  @Remote('begin')
  begin(input?: LoginRequest): Promise<{ url: string }> { return this.manager.begin(input) }
  @Remote('cancel')
  async cancel(): Promise<null> { await this.manager.cancel(); return null }
  @Remote('logout')
  async logout(): Promise<null> { await this.manager.logout(); return null }
  @Remote('recoverDevice')
  recoverDevice(action: DeviceRecoveryAction): Promise<DeviceRecoveryResult> { return this.manager.recoverDevice(action) }

  @Remote('controlConnector')
  controlConnector(action: ConnectorAction): Promise<null> { return this.manager.controlConnector(action) }
  @Remote('saveConnectorSettings')
  saveConnectorSettings(settings: ConnectorSettings): Promise<null> { return this.manager.saveConnectorSettings(settings) }
  @Remote('openConnectorFolder')
  openConnectorFolder(folder: ConnectorFolder): Promise<null> {
    return this.manager.openConnectorFolder(folder, this.ctx.get('agentsAnywhereRuntime')?.logsPath)
  }
  @Remote('resetConnector')
  resetConnector(forceLocal: boolean): Promise<null> { return this.manager.resetConnector(forceLocal) }
  @Remote('createMobileLogin')
  createMobileLogin(): Promise<MobileLoginSnapshot> { return this.manager.createMobileLogin() }
  @Remote('inspectMobileLogin')
  inspectMobileLogin(id: string): Promise<MobileLoginSnapshot> { return this.manager.inspectMobileLogin(id) }
  @Remote('confirmMobileLogin')
  confirmMobileLogin(id: string, approved: boolean): Promise<MobileLoginSnapshot> { return this.manager.confirmMobileLogin(id, approved) }

  @Remote('selection')
  async selection(input: { clientId: string, revision: number, current: string | null }): Promise<null> {
    this.ctx.get('agentsAnywhereRuntime')?.native.presence.report(input.clientId, input.revision, input.current)
    return null
  }
}
