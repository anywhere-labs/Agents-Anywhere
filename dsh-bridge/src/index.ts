import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AgentsAnywhereBridge } from './bridge.js'
import type { BridgeConfig, DshServices } from './types.js'

export const name = 'agents-anywhere-bridge'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm', 'agentDefaultModel', 'commands', 'permissionPresets', 'approval', 'userQuestions']

export interface Config extends BridgeConfig {}

export const Config: z<Config> = z.object({
  stateRoot: z.string().required(),
  maxFrameBytes: z.natural().min(1024).max(33554432).default(8388608),
  shutdownTimeoutMs: z.natural().min(100).max(60000).default(10000),
})

export class AgentsAnywhereBridgeService extends Service {
  private bridge?: AgentsAnywhereBridge

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentsAnywhereBridge')
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.bridge = new AgentsAnywhereBridge(this.ctx as unknown as DshServices, this.config)
    await this.bridge.start()
    yield async () => { await this.bridge?.dispose() }
  }
}

export default AgentsAnywhereBridgeService
export { AgentsAnywhereBridge } from './bridge.js'
export * from './identity.js'
export * from './projection.js'
