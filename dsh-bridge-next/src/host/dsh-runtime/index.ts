import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Config, stateRoot } from '../config.js'
import { RuntimeServer } from './server.js'
import { NativeRuntime } from './native.js'
import { RuntimeDiagnostics } from './diagnostics.js'

declare module '@deepseek-ai/cordis' {
  interface Context { agentsAnywhereRuntime: DshRuntimeService }
}

/** Independent of OAuth, the modal, and Desktop installation detection. */
export class DshRuntimeService extends Service {
  static inject = ['sessions', 'sessionQuery', 'workspaceRegistry']
  static Config = Config
  private readonly server: RuntimeServer
  private readonly diagnostics: RuntimeDiagnostics
  readonly native: NativeRuntime

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereRuntime')
    const home = config.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
    if (!isAbsolute(home)) throw new Error('DSH_HOME must be an absolute path')
    this.diagnostics = new RuntimeDiagnostics(ctx.logger('agents-anywhere-runtime'), join(stateRoot(config), 'logs'))
    this.native = new NativeRuntime(ctx, this.diagnostics)
    this.server = new RuntimeServer(join(home, 'agents-anywhere', 'bridge', 'endpoint.json'), {
      native: this.native,
      query: { listSessions: signal => this.native.inventory(signal), readSession: id => this.native.read(id),
        readTitleSnapshots: (...args) => ctx.sessionQuery.readTitleSnapshots(...args) },
      status: id => this.native.status(id),
    }, this.diagnostics)
    ctx.effect(() => async () => {
      try { await this.server.close(); await this.native.close() }
      finally { await this.diagnostics.flush() }
    }, 'agentsAnywhereRuntime.close')
  }

  async [Service.init](): Promise<void> { await this.server.start() }
}
