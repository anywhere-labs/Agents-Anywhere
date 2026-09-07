import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HOST_NAMESPACE, type DeviceRecoveryAction, type LoginRequest, type OnboardingHostApi, type OnboardingSnapshot } from '../../contracts/index.js'
import { Config, resolveConfig } from '../config.js'
import { OnboardingManager } from '../onboarding/manager.js'
import type {} from '../dsh-runtime/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context { agentsAnywhereOnboarding: OnboardingService }
}

/** Uses the rc.1 public Typert Gateway; no Desktop IPC or DSH Agent services. */
export class OnboardingService extends TypertRemoteService implements OnboardingHostApi {
  static Config = Config
  private readonly manager: OnboardingManager

  constructor(ctx: Context, config: Config) {
    super(ctx, HOST_NAMESPACE)
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
  @Remote('begin')
  begin(input?: LoginRequest): Promise<{ url: string }> { return this.manager.begin(input) }
  @Remote('cancel')
  async cancel(): Promise<null> { await this.manager.cancel(); return null }
  @Remote('logout')
  async logout(): Promise<null> { await this.manager.logout(); return null }
  @Remote('recoverDevice')
  recoverDevice(action: DeviceRecoveryAction): Promise<null> { return this.manager.recoverDevice(action) }

  @Remote('selection')
  async selection(input: { clientId: string, revision: number, current: string | null }): Promise<null> {
    this.ctx.get('agentsAnywhereRuntime')?.native.presence.report(input.clientId, input.revision, input.current)
    return null
  }
}
