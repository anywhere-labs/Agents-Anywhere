import type { BridgeStatus } from '../../contracts/bridge-status.js'
import { startupFailure } from './startup-status.js'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
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
  private server: RuntimeServer
  private readonly makeServer: () => RuntimeServer
  private restartTask: Promise<BridgeStatus> | undefined
  private disposed = false
  private currentStatus: BridgeStatus = { state: 'starting', message: '正在启动本机连接…', hint: '', canRetry: false }
  status(): BridgeStatus { return { ...this.currentStatus } }
  private readonly diagnostics: RuntimeDiagnostics
  readonly native: NativeRuntime

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereRuntime')
    const home = config.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
    if (!isAbsolute(home)) throw new Error('DSH_HOME must be an absolute path')
    this.diagnostics = new RuntimeDiagnostics(ctx.logger('agents-anywhere-runtime'), join(stateRoot(config), 'logs'))
    this.native = new NativeRuntime(ctx, join(home, 'agents-anywhere', 'bridge', 'create-intents'), this.diagnostics)
    this.makeServer = () => new RuntimeServer(join(home, 'agents-anywhere', 'bridge', 'endpoint.json'), {
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
    }, this.diagnostics)
    this.server = this.makeServer()
    ctx.effect(() => async () => {
      this.disposed = true
      await this.restartTask
      try { await this.server.close(); await this.native.close() }
      finally { await this.diagnostics.flush() }
    }, 'agentsAnywhereRuntime.close')
  }

  async [Service.init](): Promise<void> {
    await this.restart()
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
        await this.server.start()
        this.currentStatus = { state: 'ready', message: '本机连接已就绪', hint: '', canRetry: false }
      } catch (error) {
        this.currentStatus = startupFailure(error)
        this.diagnostics.log('error', 'bridge.restart_failed', { code: this.currentStatus.code }, error)
      }
      return this.status()
    })().finally(() => { this.restartTask = undefined })
    return this.restartTask
  }

}
