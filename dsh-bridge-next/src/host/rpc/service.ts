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
import { readBridgeLogs } from '../dsh-runtime/log-reader.js'
import type { BridgeLogSnapshot } from '../../contracts/logs.js'

declare module '@deepseek-ai/cordis' {
  interface Context { agentsAnywhereOnboarding: OnboardingService }
}

/** Uses the rc.1 public Typert Gateway; no Desktop IPC or DSH Agent services. */
export class OnboardingService extends TypertRemoteService implements OnboardingHostApi {
  static Config = Config
  private readonly manager: OnboardingManager
  private readonly logsDirectory: string

  constructor(ctx: Context, config: Config) {
    super(ctx, HOST_NAMESPACE)
    this.logsDirectory = join(stateRoot(config), 'logs')
    this.manager = new OnboardingManager(resolveConfig(config))
    ctx.effect(() => () => this.manager.dispose(), 'agentsAnywhereOnboarding.dispose')
  }

  async [Service.init](): Promise<void> {
    await this.manager.initialize()
    // Restoring an authorized connection must not prevent the settings page
    // from mounting while uv prepares its environment.
    void this.manager.resume().catch(() => undefined)
  }

  @Remote('inspect')
  inspect(): Promise<OnboardingSnapshot> { return this.manager.inspect() }
  @Remote('openDesktop')
  openDesktop(): Promise<DesktopLaunch> { return this.manager.openDesktop() }
  @Remote('readBridgeLogs')
  readBridgeLogs(): Promise<BridgeLogSnapshot> { return readBridgeLogs(this.logsDirectory) }
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
  openConnectorFolder(folder: ConnectorFolder): Promise<null> { return this.manager.openConnectorFolder(folder) }
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
