import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CLOUD_API_BASE_URL, type ConnectionSettings, type DesktopDetection, type FlowStage, type LoginRequest, type OnboardingSnapshot } from '../../contracts/index.js'
import { resolveWebAppUrl } from '../../contracts/web-address.js'
import { AccountApi, ApiError, publicProfile, type Account } from '../account/api.js'
import { ensureBinding, type Binding } from '../account/binding.js'
import { checkServer, normalizeServerOrigin, resolveOAuthWebOrigin } from '../account/server.js'
import type { ResolvedConfig } from '../config.js'
import { SourceConnector, type ConnectorProcess } from '../connector/process.js'
import { detectDesktop } from '../desktop/detect.js'
import { acquireManagerLock, readJson, writeJson } from '../storage/files.js'
import { LoopbackFlow } from './loopback.js'

interface Dependencies {
  connector?: ConnectorProcess
  detect?: () => Promise<DesktopDetection>
  api?: (baseUrl: string) => AccountApi
  checkServer?: (baseUrl: string) => Promise<void>
  readConnectorIds?: () => Promise<string[]>
  onlineTimeoutMs?: number
  pollIntervalMs?: number
}

export class OnboardingManager {
  private settings: ConnectionSettings
  private account: Account | null = null
  private binding: Required<Binding> | null = null
  private desktop: DesktopDetection = { status: 'absent', message: '正在检查本机…' }
  private stage: FlowStage = 'idle'
  private message = '登录后，将为这台电脑建立连接。'
  private flow: LoopbackFlow | null = null
  private controller: AbortController | null = null
  private work: Promise<void> | null = null
  private beginning: { key: string; promise: Promise<{ url: string }> } | null = null
  private profileRefresh: Promise<void> | null = null
  private profileCheckedAt = 0
  private readonly profileController = new AbortController()
  private releaseLock: (() => Promise<void>) | null = null
  private initialized: Promise<void> | null = null
  private disposed = false
  private operations: Promise<unknown> = Promise.resolve()
  private readonly connector: ConnectorProcess
  private readonly detect: () => Promise<DesktopDetection>
  private readonly apiFactory: (base: string) => AccountApi

  constructor(private readonly config: ResolvedConfig, private readonly dependencies: Dependencies = {}) {
    this.settings = { apiBaseUrl: config.apiBaseUrl }
    this.connector = dependencies.connector ?? new SourceConnector(config)
    this.detect = dependencies.detect ?? detectDesktop
    this.apiFactory = dependencies.api ?? (base => new AccountApi(base))
  }

  initialize(): Promise<void> {
    this.initialized ??= this.load()
    return this.initialized
  }

  private async load(): Promise<void> {
    this.releaseLock = await acquireManagerLock(join(this.config.stateRoot, 'manager.lock'), () => this.loseOwnership())
    try {
      const settings = await readJson<ConnectionSettings>(join(this.config.stateRoot, 'settings.json'))
      if (settings) {
        this.settings = this.validateSettings(settings)
        // Migrate earlier two-address settings without touching account credentials.
        if (Object.keys(settings).length !== 1 || settings.apiBaseUrl !== this.settings.apiBaseUrl) {
          await writeJson(join(this.config.stateRoot, 'settings.json'), this.settings)
        }
      }
      this.account = await readJson<Account>(join(this.config.stateRoot, 'account.json'))
      // Older installs did not write settings when signing in to the default local server.
      if (!settings && this.account) {
        this.settings = this.validateSettings({ apiBaseUrl: this.account.apiBaseUrl })
        await writeJson(join(this.config.stateRoot, 'settings.json'), this.settings)
      }
      if (this.account?.apiBaseUrl !== this.settings.apiBaseUrl) this.account = null
      this.desktop = await this.detect()
    } catch (error) {
      await this.releaseLock?.()
      this.releaseLock = null
      throw error
    }
  }

  async resume(): Promise<void> {
    await this.initialize()
    if (this.config.autoStart && this.account && this.desktop.status === 'absent') {
      // This starts only a previously authorized device. Fresh installs are idle.
      try { await this.begin() } catch (error) { this.setProgress('error', safeMessage(error)) }
    }
  }

  async inspect(): Promise<OnboardingSnapshot> {
    await this.initialize()
    this.desktop = await this.detect()
    this.refreshProfile()
    return this.snapshot()
  }

  private refreshProfile(): void {
    const account = this.account
    if (this.disposed || !account || this.profileRefresh || Date.now() - this.profileCheckedAt < 60_000) return
    this.profileCheckedAt = Date.now()
    // Keep the panel responsive when the server is offline. A profile response
    // from an old login must never recreate an account after logout or switching.
    this.profileRefresh = this.apiFactory(account.apiBaseUrl).me(account.accessToken, this.profileController.signal)
      .then(user => this.serial(async () => {
        if (this.disposed || this.account !== account || user.userId !== account.userId) return
        this.account = { ...account, ...publicProfile(user) }
        await writeJson(join(this.config.stateRoot, 'account.json'), this.account)
      }))
      .catch(() => undefined)
      .finally(() => { this.profileRefresh = null })
  }

  begin(input?: LoginRequest): Promise<{ url: string }> {
    const key = JSON.stringify(input ?? null)
    if (this.beginning) return this.beginning.key === key
      ? this.beginning.promise : Promise.reject(new Error('正在开始另一次登录，请稍候。'))
    const promise = this.serial(() => this.startFlow(input)).finally(() => { this.beginning = null })
    this.beginning = { key, promise }
    return promise
  }

  private async startFlow(input?: LoginRequest): Promise<{ url: string }> {
    await this.initialize()
    if (this.disposed) throw new Error('插件已关闭。')
    if (input && input.target !== 'cloud' && input.target !== 'server') throw new Error('请选择云端或自建服务器。')
    const next = this.validateSettings({ apiBaseUrl: input?.target === 'cloud' ? CLOUD_API_BASE_URL
      : input?.target === 'server' ? input.serverUrl : this.settings.apiBaseUrl })
    this.desktop = await this.detect()
    if (this.desktop.status !== 'absent') throw new Error(this.desktop.message)
    await (this.dependencies.checkServer ?? checkServer)(next.apiBaseUrl)
    if (this.disposed) throw new Error('插件已关闭。')
    await this.connector.prepare()
    if (this.disposed) throw new Error('插件已关闭。')
    if (next.apiBaseUrl !== this.settings.apiBaseUrl) await this.logoutFlow()
    else await this.cancelFlow()
    await writeJson(join(this.config.stateRoot, 'settings.json'), next)
    this.settings = next
    const controller = new AbortController()
    this.controller = controller
    const flow = new LoopbackFlow(
      (code) => this.launch(flow, controller, code),
      (message) => { controller.abort(); this.setProgress('error', message); },
    )
    this.flow = flow
    await flow.listen()
    this.setProgress('authorizing', '请在浏览器登录并授权。')
    if (this.account && this.account.expiresAt > Date.now() + 30_000) {
      try {
        const user = await this.apiFactory(this.settings.apiBaseUrl).me(this.account.accessToken, controller.signal)
        if (user.userId !== this.account.userId) throw new Error('账号发生变化，请重新登录。')
        this.account = { ...this.account, ...publicProfile(user) }
        this.profileCheckedAt = Date.now()
        await writeJson(join(this.config.stateRoot, 'account.json'), this.account)
        this.launch(flow, controller)
        return { url: flow.progressUrl }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          this.setProgress('error', safeMessage(error)); throw error
        }
        this.account = null
      }
    }
    return { url: flow.authorizationUrl(resolveOAuthWebOrigin(this.settings.apiBaseUrl)) }
  }

  private launch(flow: LoopbackFlow, controller: AbortController, code?: string): void {
    this.work = this.connect(flow, controller.signal, code).catch(async (error: unknown) => {
      if (this.flow === flow) this.setProgress('error', controller.signal.aborted ? '本次连接已取消，请重新开始。' : safeMessage(error))
      await this.connector.stop()
    })
  }

  private async connect(flow: LoopbackFlow, signal: AbortSignal, code?: string): Promise<void> {
    const api = this.apiFactory(this.settings.apiBaseUrl)
    if (code) {
      const account = await api.exchange(code, flow.verifier, flow.redirectUri, signal)
      signal.throwIfAborted()
      if (this.account?.userId !== account.userId) await this.connector.stop()
      this.account = account
      this.profileCheckedAt = Date.now()
      await writeJson(join(this.config.stateRoot, 'account.json'), account)
    }
    const account = this.account
    if (!account) throw new Error('请先完成登录。')
    signal.throwIfAborted()
    this.setProgress('pairing', '登录成功，正在连接本机设备…')
    this.binding = await ensureBinding(this.config.stateRoot, account, api, signal, {
      ...(this.dependencies.readConnectorIds ? { readConnectorIds: this.dependencies.readConnectorIds } : {}),
      renew: Boolean(code),
    })
    signal.throwIfAborted()
    this.setProgress('starting', '正在启动本机连接，首次准备运行环境可能需要几分钟…')
    await this.connector.start(this.binding, this.settings.apiBaseUrl, signal)
    const deadline = Date.now() + (this.dependencies.onlineTimeoutMs ?? 120_000)
    for (;;) {
      signal.throwIfAborted()
      await this.connector.assertHealthy()
      try {
        const device = await api.device(account.accessToken, this.binding.connectorId, signal)
        if (device.userId !== account.userId) throw new Error('设备归属与当前账号不一致。')
        if (device.status === 'online') break
      } catch (error) {
        if (!(error instanceof ApiError) || error.status < 500) throw error
      }
      if (Date.now() >= deadline) throw new Error('设备暂未上线，请检查网络后在插件中重试。')
      await delay(this.dependencies.pollIntervalMs ?? 1_000, undefined, { signal })
    }
    signal.throwIfAborted()
    const url = new URL(`${resolveOAuthWebOrigin(this.settings.apiBaseUrl)}/`)
    url.hash = `/onboarding?${new URLSearchParams({ source: 'dsh-plugin', connectorId: this.binding.connectorId, flowId: flow.id })}`
    this.stage = 'ready'
    this.message = '设备已上线，正在继续 Web 引导…'
    flow.update({ stage: 'ready', message: this.message, redirectUrl: url.href })
  }

  cancel(): Promise<void> { return this.serial(() => this.cancelFlow()) }

  private async cancelFlow(): Promise<void> {
    this.controller?.abort()
    if (this.work) await this.work
    this.work = null
    this.controller = null
    if (this.flow) await this.flow.close()
    this.flow = null
    if (this.stage !== 'ready') this.setProgress('idle', '可以重新开始连接。')
  }

  logout(): Promise<void> {
    return this.serial(async () => {
      await this.initialize()
      if (this.disposed) throw new Error('插件已关闭。')
      await this.logoutFlow()
    })
  }

  private async logoutFlow(): Promise<void> {
    await this.cancelFlow()
    await this.connector.stop()
    this.account = null
    this.profileCheckedAt = 0
    this.binding = null
    await rm(join(this.config.stateRoot, 'account.json'), { force: true })
    this.setProgress('idle', '已退出登录，本机连接已停止。')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller?.abort()
    this.profileController.abort()
    await this.profileRefresh
    await this.serial(async () => {
      await this.initialized?.catch(() => undefined)
      try { await this.cancelFlow(); await this.connector.stop() } finally { await this.releaseLock?.(); this.releaseLock = null }
    })
  }

  private loseOwnership(): void {
    this.disposed = true
    this.controller?.abort()
    this.profileController.abort()
    this.releaseLock = null
    const report = () => this.setProgress('error', '本机管理锁已失效，连接已停止。请重新加载插件。')
    void this.serial(async () => {
      try { await this.cancelFlow(); await this.connector.stop() } finally { report() }
    }).catch(report)
  }

  private validateSettings(settings: ConnectionSettings): ConnectionSettings {
    return { apiBaseUrl: normalizeServerOrigin(settings.apiBaseUrl) }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(action)
    this.operations = operation.catch(() => undefined)
    return operation
  }

  private setProgress(stage: FlowStage, message: string): void {
    this.stage = stage
    this.message = message
    this.flow?.update({ stage, message })
  }

  private snapshot(): OnboardingSnapshot {
    return {
      desktop: this.desktop, settings: { ...this.settings }, stage: this.stage, message: this.message,
      account: this.account ? publicProfile(this.account) : null,
      webAppUrl: resolveWebAppUrl(this.settings.apiBaseUrl),
      connectorId: this.binding?.connectorId ?? null, connectorRunning: this.connector.running, flowId: this.flow?.id ?? null,
    }
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof TypeError) return '无法连接服务，请检查网络和连接地址。'
  return error instanceof Error ? error.message : '连接失败，请重试。'
}
