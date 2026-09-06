import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Config } from '../config.js'
import { RuntimeServer } from './server.js'

declare module '@deepseek-ai/cordis' {
  interface Context { agentsAnywhereRuntime: DshRuntimeService }
}

/** Independent of OAuth, the modal, and Desktop installation detection. */
export class DshRuntimeService extends Service {
  static inject = ['sessions', 'sessionQuery']
  static Config = Config
  private readonly server: RuntimeServer

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereRuntime')
    const home = config.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
    if (!isAbsolute(home)) throw new Error('DSH_HOME must be an absolute path')
    let agents: Context['agents'] | undefined
    ctx.inject(['agents'], child => {
      agents = child.agents
      child.effect(() => () => { agents = undefined }, 'agentsAnywhereRuntime.detachAgents')
    })
    this.server = new RuntimeServer(join(home, 'agents-anywhere', 'bridge', 'endpoint.json'), {
      query: ctx.sessionQuery,
      status: id => agents?.get(id)?.status,
    })
    ctx.effect(() => () => this.server.close(), 'agentsAnywhereRuntime.close')
  }

  async [Service.init](): Promise<void> { await this.server.start() }
}
