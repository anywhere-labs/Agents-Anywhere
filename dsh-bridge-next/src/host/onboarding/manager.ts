import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CLOUD_API_BASE_URL, type ConnectionSettings, type DesktopDetection, type DesktopLaunch, type DeviceRecovery, type DeviceRecoveryAction, type DeviceRecoveryResult, type FlowStage, type LoginRequest, type OnboardingSnapshot } from '../../contracts/index.js'
import { resolveOnboardingUrl, resolveWebAppUrl } from '../../contracts/web-address.js'
import { AccountApi, ApiError, publicProfile, type Account } from '../account/api.js'
import { DeviceRecoveryRequired, ensureBinding, readBoundDevice, recoverBinding, verifyBoundDevice, type BoundDevice } from '../account/binding.js'
import { checkServer, normalizeServerOrigin, resolveOAuthWebOrigin } from '../account/server.js'
import type { ResolvedConfig } from '../config.js'
import { ConnectorCredentialError, ConnectorOwnershipError, SourceConnector, type ConnectorProcess } from '../connector/process.js'
import { detectDesktop } from '../desktop/detect.js'
import { desktopOnboardingUrl, launchDesktop, newDesktopFlowId, type DesktopLauncher } from '../desktop/launch.js'
import type { LocalMachineRegistry } from '../desktop/machine-state.js'
import { acquireManagerLock, readJson, writeJson } from '../storage/files.js'
import { migrateStateRoot } from '../storage/migration.js'
import { LoopbackFlow } from './loopback.js'
import type { ConnectorAction, ConnectorFolder, ConnectorSettings } from '../../contracts/connector.js'
import type { RuntimeLogPage, RuntimeLogQuery, StartupFailureDiagnostic } from '../../contracts/logs.js'
import { startupFailure, startupFailureDiagnostic } from '../dsh-runtime/startup-status.js'
import { ConnectorSettingsStore, validateConnectorSettings } from '../connector/settings.js'
import { canOpenFolders, openFolder, resolveUv } from '../connector/environment.js'
import { MobileLogin } from '../account/mobile.js'
import type { MobileLoginSnapshot } from '../../contracts/mobile.js'
import { RuntimeDiagnostics } from '../dsh-runtime/diagnostics.js'
import { RpcLogOutput } from '../dsh-runtime/log-output.js'

interface Dependencies {
  rolePollIntervalMs?: number
  connector?: ConnectorProcess
  detect?: () => Promise<DesktopDetection>
  launchDesktop?: DesktopLauncher
  api?: (baseUrl: string) => AccountApi
  checkServer?: (baseUrl: string) => Promise<void>
  machineState?: LocalMachineRegistry
  onlineTimeoutMs?: number
  pollIntervalMs?: number
  openFolder?: (path: string) => Promise<void>
  systemLanguages?: () => Promise<string[]>
  diagnostics?: RuntimeDiagnostics
  logOutput?: RpcLogOutput
  /** Waits between automatic startup attempts; the last value repeats until one succeeds. */
  resumeRetryDelaysMs?: number[]
}

const RESUME_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000]
/** Account tokens this close to expiry are treated as expired, matching the login check. */
const ACCOUNT_EXPIRY_MARGIN_MS = 30_000

/** The account token no longer works, and the device credential cannot carry the connection alone. */
class AccountLoginRequired extends Error {
  constructor(readonly connectorId: string | null, message = '账号登录已失效，请重新登录。') { super(message) }
}

export class OnboardingManager {
  private connectionFailure: StartupFailureDiagnostic | null = null
  startupDiagnostic(): StartupFailureDiagnostic | null { return this.connectionFailure ? { ...this.connectionFailure } : null }

  /** Connection-phase failures only; earlier errors are answered by the call that raised them. */
  private recordConnectionFailure(error: unknown): void {
    const status = startupFailure(error)
    const invalidState = error instanceof Error && 'code' in error && error.code === 'CONNECTOR_SYNC_STATE_INVALID'
    this.connectionFailure = startupFailureDiagnostic(error, 'plugin', 'connector.start_failed', {
      ...status, code: invalidState ? 'CONNECTOR_SYNC_STATE_INVALID' : 'CONNECTOR_START_FAILED',
      message: invalidState ? 'Connector 同步状态文件无效。终端输出中列出了文件路径；请在“设置 → 维护”中打开数据目录，移走该文件后重新启动 Connector。'
        : 'Connector 连接失败，详情见下方错误信息和终端输出。',
    })
    this.diagnostics.log('error', 'connector.start_failed', {}, error)
  }
  private settings: ConnectionSettings
  private account: Account | null = null
  private binding: BoundDevice | null = null
  private recovery: DeviceRecovery | null = null
  private recoveryCheck: Promise<void> | null = null
  private recoveryController: AbortController | null = null
  private readonly unsubscribeConnector: () => void
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
  private readonly launchDesktop: DesktopLauncher
  private readonly apiFactory: (base: string) => AccountApi
  private readonly connectorSettings: ConnectorSettingsStore
  private readonly mobile = new MobileLogin()
  private readonly logOutput: RpcLogOutput
  private readonly diagnostics: RuntimeDiagnostics
  private roleCheck: Promise<void> | null = null
  private roleTimer: ReturnType<typeof setInterval> | null = null
  private resolvedUvPath: string | null = null
  private resuming: Promise<void> | null = null
  private resumeController: AbortController | null = null

  constructor(private readonly config: ResolvedConfig, private readonly dependencies: Dependencies = {}) {
    this.settings = { apiBaseUrl: config.apiBaseUrl }
    this.connectorSettings = new ConnectorSettingsStore(config, dependencies.systemLanguages)
    this.logOutput = dependencies.logOutput ?? new RpcLogOutput(512, 'plugin')
    this.diagnostics = dependencies.diagnostics ?? new RuntimeDiagnostics(this.logOutput, {}, 'dsh-plugin')
    this.connector = dependencies.connector ?? new SourceConnector(
      config,
      undefined,
      () => this.connectorSettings.get(),
      undefined,
      undefined,
      this.diagnostics,
      this.logOutput,
    )
    this.detect = dependencies.detect ?? detectDesktop
    this.launchDesktop = dependencies.launchDesktop ?? launchDesktop
    this.apiFactory = dependencies.api ?? (base => new AccountApi(base))
    this.unsubscribeConnector = this.connector.onState(state => {
      if (state.authFailed && this.binding && this.account && !this.disposed) {
        void this.checkDeviceRecovery(this.binding.connectorId)
      }
    })
  }

  hasRuntimeLogs(): boolean { return this.connector.hasRuntimeLogs?.() ?? false }
  get logsPath(): string | null { return this.connector.logsPath ?? null }
  get pluginLogOutput(): RpcLogOutput { return this.logOutput }

  async readRuntimeLogs(query?: RuntimeLogQuery): Promise<RuntimeLogPage> {
    if (this.connector.readRuntimeLogs && this.connector.hasRuntimeLogs?.()) {
      return this.connector.readRuntimeLogs(query)
    }
    return {
      available: false,
      items: [],
      firstSeq: null,
      lastSeq: null,
      total: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      logsPath: this.connector.logsPath ?? null,
      updatedAt: new Date().toISOString(),
    }
  }

  initialize(): Promise<void> {
    this.initialized ??= this.load()
    return this.initialized
  }

  private async load(): Promise<void> {
    this.releaseLock = await acquireManagerLock(join(this.config.stateRoot, 'manager.lock'), () => this.loseOwnership())
    try {
      await migrateStateRoot(this.config.stateRoot, this.config.legacyStateRoot)
      await this.refreshRole()
      await this.connectorSettings.load()
      this.resolvedUvPath = await resolveUv(this.config, this.connectorSettings.get())
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
      if (this.account) this.binding = await readBoundDevice(this.config.stateRoot, this.account)
      this.roleTimer = setInterval(() => {
        const wasBlocked = this.desktop.status !== 'absent'
        void this.refreshRole().then(() => {
          if (wasBlocked && !this.disposed && this.desktop.status === 'absent' && this.account) void this.resume()
        }).catch(error => this.setProgress('error', safeMessage(error)))
      }, this.dependencies.rolePollIntervalMs ?? 1500)
      this.roleTimer.unref()
    } catch (error) {
      await this.releaseLock?.()
      this.releaseLock = null
      throw error
    }
  }

  /**
   * Starts a previously authorized device without user interaction; fresh
   * installs stay idle. It never opens a login page: the device credential
   * carries the connection when the account token has expired, and failures
   * that may pass (network not ready at boot, server restarting) are retried
   * with backoff until one attempt succeeds or the user takes over.
   */
  resume(): Promise<void> {
    this.resuming ??= this.resumeLoop().finally(() => { this.resuming = null })
    return this.resuming
  }

  private async resumeLoop(): Promise<void> {
    await this.initialize()
    const controller = new AbortController()
    this.resumeController = controller
    const delays = this.dependencies.resumeRetryDelaysMs ?? RESUME_RETRY_DELAYS_MS
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (controller.signal.aborted || this.disposed || !this.account || this.desktop.status !== 'absent') return
        try {
          await this.serial(async () => {
            if (controller.signal.aborted || this.connector.running) return
            await this.requireStandalone()
            if (!this.account || this.recovery) return
            await (this.dependencies.checkServer ?? checkServer)(this.settings.apiBaseUrl)
            await this.connector.prepare()
            if (controller.signal.aborted) return
            await this.startConnector()
          })
          return
        } catch (error) {
          // Desktop took over, the user acted, or the device needs an explicit decision.
          if (controller.signal.aborted || this.disposed || this.desktop.status !== 'absent' || this.recovery) return
          if (!canRetryResume(error)) { this.setProgress('error', safeMessage(error)); return }
          const wait = delays[Math.min(attempt, delays.length - 1)] ?? RESUME_RETRY_DELAYS_MS[0]!
          this.diagnostics.log('warn', 'onboarding.resume_retry', { attempt: attempt + 1, delayMs: wait }, error)
          this.setProgress('error', `${safeMessage(error)}（${Math.ceil(wait / 1000)} 秒后自动重试）`)
          try { await delay(wait, undefined, { signal: controller.signal }) } catch { return }
        }
      }
    } finally {
      if (this.resumeController === controller) this.resumeController = null
    }
  }

  /** A user action takes over from automatic startup; a pending retry must not undo it. */
  private stopResume(): void {
    this.resumeController?.abort()
    this.resumeController = null
  }

  unavailableSnapshot(message: string): OnboardingSnapshot {
    return { ...this.snapshot(), stage: 'error', message, ownership: { status: 'error', message } }
  }

  async inspect(): Promise<OnboardingSnapshot> {
    await this.initialize()
    await this.refreshRole()
    if (this.desktop.status === 'absent') this.refreshProfile()
    else this.mobile.clear()
    return this.snapshot()
  }

  /**
   * Hand this machine over to the Desktop app. The plugin never manages the
   * account, the device or the Connector once Desktop is installed; it only
   * publishes its DSH runtime endpoint and opens the Desktop onboarding entry.
   * Every request starts a new flow, and the URL carries no credentials and no
   * caller-supplied path or command.
   */
  async openDesktop(): Promise<DesktopLaunch> {
    await this.initialize()
    if (this.disposed) throw new Error('插件已关闭。')
    await this.refreshRole()
    if (this.desktop.status !== 'installed') throw new Error(this.desktop.message)
    const flowId = newDesktopFlowId()
    const url = desktopOnboardingUrl(flowId)
    try {
      await this.launchDesktop({
        executablePath: this.desktop.executablePath,
        launchArgs: this.desktop.launchArgs,
        packaged: this.desktop.packaged,
      }, url)
    } catch (error) {
      throw new Error(`无法打开 Agents Anywhere 桌面端：${error instanceof Error ? error.message : String(error)}`)
    }
    return { flowId, url }
  }

  private refreshProfile(): void {
    const account = this.account
    if (this.disposed || !account || this.accountExpired(account) || this.profileRefresh || Date.now() - this.profileCheckedAt < 60_000) return
    this.profileCheckedAt = Date.now()
    // Keep the panel responsive when the server is offline. A profile response
    // from an old login must never recreate an account after logout or switching.
    this.profileRefresh = this.apiFactory(account.apiBaseUrl).me(account.accessToken, this.profileController.signal)
      .then(user => this.serial(async () => {
        if (this.disposed || this.account !== account || user.userId !== account.userId) return
        this.account = { ...account, ...publicProfile(user) }
        await writeJson(join(this.config.stateRoot, 'account.json'), this.account)
      }))
      .catch(error => error instanceof ApiError && error.status === 401
        ? this.serial(() => this.markAccountExpired(account)).catch(() => undefined) : undefined)
      .finally(() => { this.profileRefresh = null })
  }

  begin(input?: LoginRequest): Promise<{ url: string }> {
    this.stopResume()
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
    await this.requireStandalone()
    await (this.dependencies.checkServer ?? checkServer)(next.apiBaseUrl)
    if (this.disposed) throw new Error('插件已关闭。')
    await this.connector.prepare()
    if (this.disposed) throw new Error('插件已关闭。')
    await this.requireStandalone()
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
        controller.signal.throwIfAborted()
        if (user.userId !== this.account.userId) throw new Error('账号发生变化，请重新登录。')
        this.account = { ...this.account, ...publicProfile(user) }
        this.profileCheckedAt = Date.now()
        await writeJson(join(this.config.stateRoot, 'account.json'), this.account)
        await this.requireStandalone()
        controller.signal.throwIfAborted()
        this.launch(flow, controller)
        return { url: flow.progressUrl }
      } catch (error) {
        if (this.desktop.status !== 'absent') throw new Error(this.desktop.message)
        if (!(error instanceof ApiError) || error.status !== 401) {
          this.setProgress('error', safeMessage(error)); throw error
        }
        // Keep the account and device: a running Connector continues on its own credential.
        await this.markAccountExpired(this.account)
      }
    }
    return { url: flow.authorizationUrl(resolveOAuthWebOrigin(this.settings.apiBaseUrl)) }
  }

  private launch(flow: LoopbackFlow, controller: AbortController, code?: string): void {
    this.work = this.connect(flow, controller.signal, code).catch(async (error: unknown) => {
      if (this.flow === flow && !controller.signal.aborted) await this.connectionFailed(error)
      await this.connector.stop()
    })
  }

  private async connect(flow: LoopbackFlow, signal: AbortSignal, code?: string): Promise<void> {
    await this.requireStandalone()
    signal.throwIfAborted()
    const api = this.apiFactory(this.settings.apiBaseUrl)
    if (code) {
      this.mobile.clear()
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
    const previousId = this.binding?.connectorId
    this.binding = await ensureBinding(this.config.stateRoot, account, api, signal, {
      ...(this.dependencies.machineState ? { machineState: this.dependencies.machineState } : {}),
      renew: Boolean(code),
    })
    // A Connector kept running on its own credential while signed out must not keep the old device.
    if (previousId && previousId !== this.binding.connectorId) await this.connector.stop()
    this.recovery = null
    await this.requireStandalone()
    signal.throwIfAborted()
    this.setProgress('starting', '正在启动本机连接，首次准备运行环境可能需要几分钟…')
    await this.connector.start(this.binding, this.settings.apiBaseUrl, signal)
    await this.waitOnline(api, account, this.binding.connectorId, signal)
    signal.throwIfAborted()
    const redirectUrl = resolveOnboardingUrl(this.settings.apiBaseUrl, this.binding.connectorId, flow.id)
    this.stage = 'ready'
    this.message = '设备已上线，正在继续 Web 引导…'
    flow.update({ stage: 'ready', message: this.message, redirectUrl })
  }

  private async waitOnline(api: AccountApi, account: Account, id: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.dependencies.onlineTimeoutMs ?? 120_000)
    for (;;) {
      signal.throwIfAborted()
      await this.connector.assertHealthy()
      try {
        const device = await api.device(account.accessToken, id, signal)
        if (device.userId !== account.userId) throw new Error('设备归属与当前账号不一致。')
        if (device.status === 'online') break
      } catch (error) {
        if (!(error instanceof ApiError) || error.status < 500) throw error
      }
      if (Date.now() >= deadline) throw new Error('设备暂未上线，请检查网络后在插件中重试。')
      await delay(this.dependencies.pollIntervalMs ?? 1_000, undefined, { signal })
    }
  }

  private setRecovery(connectorId: string, status: DeviceRecovery['status'], message: string): void {
    this.recovery = { connectorId, status, message }
    this.setProgress('error', message)
  }

  private checkDeviceRecovery(id: string): Promise<void> {
    if (this.recoveryCheck) return this.recoveryCheck
    const account = this.account
    if (!account || this.disposed) return Promise.resolve()
    const controller = new AbortController()
    this.recoveryController = controller
    this.setRecovery(id, 'checking', '本机连接已中断，正在检查设备状态…')
    const task = (async () => {
      try {
        const device = await this.apiFactory(account.apiBaseUrl).device(account.accessToken, id, controller.signal)
        controller.signal.throwIfAborted()
        if (device.userId !== account.userId) throw new Error('设备归属与当前账号不一致。')
        this.setRecovery(id, 'disconnected', new DeviceRecoveryRequired(id, 'disconnected').message)
      } catch (error) {
        if (controller.signal.aborted || this.disposed) return
        if (error instanceof ApiError && error.status === 404) this.setRecovery(id, 'deleted', new DeviceRecoveryRequired(id, 'deleted').message)
        else if (error instanceof ApiError && error.status === 401) {
          await this.markAccountExpired(account)
          this.setRecovery(id, 'login_required', '账号登录已失效，请重新登录后恢复设备连接。')
        } else this.setRecovery(id, 'unavailable', '暂时无法确认设备状态，请检查网络后重试。')
      }
    })().finally(() => {
      if (this.recoveryCheck === task) { this.recoveryCheck = null; this.recoveryController = null }
    })
    this.recoveryCheck = task
    return task
  }

  private async connectionFailed(error: unknown): Promise<void> {
    this.recordConnectionFailure(error)
    if (error instanceof DeviceRecoveryRequired) this.setRecovery(error.connectorId, error.reason, error.message)
    else if (error instanceof AccountLoginRequired && error.connectorId) this.setRecovery(error.connectorId, 'login_required', error.message)
    else if (error instanceof ConnectorCredentialError && this.binding) await this.checkDeviceRecovery(this.binding.connectorId)
    else if (error instanceof ApiError && error.status === 401 && this.binding) this.setRecovery(this.binding.connectorId, 'login_required', '账号登录已失效，请重新登录后恢复设备连接。')
    else if (!this.recovery) this.setProgress('error', safeMessage(error))
  }

  recoverDevice(action: DeviceRecoveryAction): Promise<DeviceRecoveryResult> {
    this.stopResume()
    return this.serial(async () => {
      await this.initialize()
      if (this.disposed) throw new Error('插件已关闭。')
      await this.requireStandalone()
      const recovery = this.recovery, account = this.account
      if (!recovery || !account) throw new Error('设备状态已变化，请重新打开插件。')
      if (action === 'check') { await this.checkDeviceRecovery(recovery.connectorId); return null }
      if ((action !== 'reconnect' || recovery.status !== 'disconnected') && (action !== 'recreate' || recovery.status !== 'deleted')) {
        throw new Error('设备状态已变化，请先重新检查。')
      }
      await this.cancelFlow()
      const controller = new AbortController()
      this.controller = controller
      try {
        await this.connector.prepare()
        await this.connector.stop()
        await this.requireStandalone()
        controller.signal.throwIfAborted()
        this.setProgress('pairing', action === 'recreate' ? '正在重新创建设备…' : '正在恢复设备连接…')
        this.binding = await recoverBinding(this.config.stateRoot, account, this.apiFactory(account.apiBaseUrl), controller.signal,
          recovery.connectorId, action)
        this.recovery = null
        await this.requireStandalone()
        controller.signal.throwIfAborted()
        this.setProgress('starting', '正在启动本机连接…')
        await this.connector.start(this.binding, account.apiBaseUrl, controller.signal)
        await this.waitOnline(this.apiFactory(account.apiBaseUrl), account, this.binding.connectorId, controller.signal)
        controller.signal.throwIfAborted()
        this.setProgress('ready', '本机设备已连接。')
        if (action === 'recreate') {
          // A fresh flow always starts at Welcome, even if the browser finished an earlier setup.
          return { url: resolveOnboardingUrl(account.apiBaseUrl, this.binding.connectorId, randomUUID()) }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof DeviceRecoveryRequired || error instanceof ConnectorCredentialError) await this.connectionFailed(error)
          else {
            this.recordConnectionFailure(error)
            this.setRecovery(this.binding?.connectorId ?? recovery.connectorId,
              error instanceof ApiError && error.status === 401 ? 'login_required' : 'unavailable',
              error instanceof ApiError && error.status === 401 ? '账号登录已失效，请重新登录后恢复设备连接。' : '恢复连接失败，请检查设备状态后重试。')
          }
        }
        await this.connector.stop()
      } finally { if (this.controller === controller) this.controller = null }
      return null
    })
  }

  cancel(): Promise<void> { this.stopResume(); return this.serial(() => this.cancelFlow()) }

  private async requireStandalone(): Promise<void> {
    await this.initialize()
    if (this.disposed) throw new Error('插件已关闭。')
    if (this.roleCheck) await this.roleCheck
    await this.refreshRole()
    if (this.disposed) throw new Error('插件已关闭。')
    if (this.desktop.status !== 'absent') { this.mobile.clear(); throw new Error(this.desktop.message) }
  }

  private requireAccount(): Account {
    const account = this.requireSignedIn()
    if (account.expiresAt <= Date.now()) throw new Error('登录已失效，请重新登录。')
    return account
  }

  /** Connector control needs a signed-in device, not a live account token. */
  private requireSignedIn(): Account {
    if (!this.account) throw new Error('请先在“登录和连接”中登录。')
    return this.account
  }

  private accountExpired(account: Account): boolean {
    return account.expiresAt <= Date.now() + ACCOUNT_EXPIRY_MARGIN_MS
  }

  /** The server rejected this token: remember it, so the next start goes straight to the device credential. */
  private async markAccountExpired(account: Account): Promise<void> {
    if (this.account?.userId !== account.userId || this.account.apiBaseUrl !== account.apiBaseUrl || this.account.expiresAt === 0) return
    this.account = { ...this.account, expiresAt: 0 }
    await writeJson(join(this.config.stateRoot, 'account.json'), this.account)
  }

  controlConnector(action: ConnectorAction): Promise<null> {
    this.stopResume()
    if (action === 'stop' && !this.disposed && this.desktop.status === 'absent') {
      this.controller?.abort()
    }
    return this.serial(async () => {
      await this.requireStandalone()
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error('不支持的 Connector 操作。')
      await this.cancelFlow()
      if (action === 'stop') {
        await this.connector.stop()
        this.setProgress('idle', 'Connector 已停止。')
      } else {
        if (this.recovery) throw new Error('请先在“登录和连接”中恢复设备连接。')
        this.requireSignedIn()
        // Validate the executable before interrupting a working connection.
        await this.connector.prepare()
        if (action === 'restart') await this.connector.stop()
        if (!this.connector.running) await this.startConnector()
      }
      return null
    })
  }

  private async startConnector(): Promise<void> {
    await this.requireStandalone()
    if (this.disposed) throw new Error('插件已关闭。')
    const account = this.requireSignedIn()
    const controller = new AbortController()
    this.controller = controller
    try {
      let viaAccount = !this.accountExpired(account)
      if (viaAccount) {
        try { await this.startWithAccount(account, controller.signal) }
        catch (error) {
          if (controller.signal.aborted || !(error instanceof ApiError) || error.status !== 401) throw error
          await this.markAccountExpired(account)
          viaAccount = false
        }
      }
      if (!viaAccount) await this.startWithDevice(account, controller.signal)
      this.setProgress('ready', '本机设备已连接。')
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.connectionFailed(error)
        await this.connector.stop()
        throw error
      }
      await this.connector.stop()
      if (this.desktop.status !== 'absent') throw new Error(this.desktop.message)
    } finally { if (this.controller === controller) this.controller = null }
  }

  private async startWithAccount(account: Account, signal: AbortSignal): Promise<void> {
    const api = this.apiFactory(account.apiBaseUrl)
    this.setProgress('pairing', '正在检查本机设备…')
    this.binding = this.binding ? await verifyBoundDevice(this.binding, account, api, signal)
      : await ensureBinding(this.config.stateRoot, account, api, signal, {
        ...(this.dependencies.machineState ? { machineState: this.dependencies.machineState } : {}),
      })
    await this.requireStandalone()
    signal.throwIfAborted()
    if (this.disposed) throw new Error('插件已关闭。')
    this.setProgress('starting', '正在启动 Connector…')
    await this.connector.start(this.binding, account.apiBaseUrl, signal)
    await this.waitOnline(api, account, this.binding.connectorId, signal)
  }

  /**
   * The Connector authenticates with its own device credential, which outlives
   * the 7-day account token. Synchronization keeps running; only account
   * features (profile, device management, mobile pairing) wait for a new login.
   */
  private async startWithDevice(account: Account, signal: AbortSignal): Promise<void> {
    const binding = this.binding ?? await readBoundDevice(this.config.stateRoot, account)
    if (!binding) throw new AccountLoginRequired(null)
    this.setProgress('pairing', '正在检查本机设备…')
    if (!await this.apiFactory(account.apiBaseUrl).verifyConnector(binding.connectorId, binding.connectorToken, signal)) {
      throw new AccountLoginRequired(binding.connectorId, '本机设备凭据已失效，且账号登录已过期，请重新登录后恢复连接。')
    }
    this.binding = binding
    await this.requireStandalone()
    signal.throwIfAborted()
    if (this.disposed) throw new Error('插件已关闭。')
    this.setProgress('starting', '正在启动 Connector…')
    await this.connector.start(binding, account.apiBaseUrl, signal)
    await this.connector.assertHealthy()
  }

  saveConnectorSettings(input: ConnectorSettings): Promise<null> {
    return this.serial(async () => {
      await this.requireStandalone()
      if (this.stage === 'authorizing' || this.stage === 'pairing' || this.stage === 'starting') throw new Error('连接正在进行，请完成或取消后再保存设置。')
      const next = validateConnectorSettings(input)
      const previous = this.connectorSettings.get()
      if (JSON.stringify(next) === JSON.stringify(previous)) return null
      const restart = this.connector.running
      if (restart) this.requireSignedIn()
      if (restart || next.uvPath !== previous.uvPath) await this.connector.prepare(next)
      if (this.disposed) throw new Error('插件已关闭。')
      await this.connectorSettings.save(next)
      this.resolvedUvPath = await resolveUv(this.config, next)
      if (restart) {
        await this.cancelFlow()
        await this.connector.stop()
        await this.startConnector()
      }
      return null
    })
  }

  async openConnectorFolder(folder: ConnectorFolder, fallbackLogsPath?: string | null): Promise<null> {
    await this.requireStandalone()
    if (folder !== 'data' && folder !== 'logs') throw new Error('不支持的目录。')
    if (folder === 'data') {
      await (this.dependencies.openFolder ?? openFolder)(join(this.config.stateRoot, 'connector'))
      return null
    }
    const logsPath = (await this.connector.resolveLogsPath?.()) ?? this.connector.logsPath ?? fallbackLogsPath ?? null
    if (!logsPath) throw new Error('Connector 尚未就绪，暂未获取到日志目录。')
    await (this.dependencies.openFolder ?? openFolder)(logsPath)
    return null
  }

  resetConnector(forceLocal: boolean): Promise<null> {
    this.stopResume()
    return this.serial(async () => {
      await this.requireStandalone()
      if (typeof forceLocal !== 'boolean') throw new Error('重置参数无效。')
      if (this.binding && this.account && !forceLocal) {
        try {
          // Reuse Desktop's revoke-and-discard semantics. A failed revoke leaves
          // local credentials intact, allowing retry or a separate local-only reset.
          await this.apiFactory(this.account.apiBaseUrl).renewConnector(this.account.accessToken, this.binding.connectorId, this.profileController.signal)
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw new Error(`无法撤销设备连接。${safeMessage(error)}`)
        }
      }
      await this.cancelFlow()
      this.mobile.clear()
      await this.connector.stop()
      this.account = null; this.binding = null; this.recovery = null; this.profileCheckedAt = 0
      // Never remove stateRoot itself, the shared Connector record, or the DSH runtime.
      for (const path of ['account.json', 'settings.json', 'bindings', 'connector', 'logs']) {
        await rm(join(this.config.stateRoot, path), { force: true, recursive: true })
      }
      this.settings = { apiBaseUrl: this.config.apiBaseUrl }
      await this.connectorSettings.reset()
      this.resolvedUvPath = await resolveUv(this.config, this.connectorSettings.get())
      this.setProgress('idle', '已恢复出厂设置，请重新登录。')
      return null
    })
  }

  /** Rebuilds the Connector's dependency environment; account, device binding and settings stay. */
  resetConnectorEnvironment(): Promise<null> {
    this.stopResume()
    // A stuck installation holds the queue, and clearing it is the reason to be here.
    if (!this.disposed && this.desktop.status === 'absent') this.controller?.abort()
    return this.serial(async () => {
      await this.requireStandalone()
      await this.cancelFlow()
      await this.connector.resetEnvironment()
      if (this.recovery || !this.account) {
        this.setProgress('idle', '依赖环境已清空，下次连接时会重新安装。')
        return null
      }
      await this.connector.prepare()
      await this.startConnector()
      return null
    })
  }

  createMobileLogin(): Promise<MobileLoginSnapshot> {
    return this.serial(async () => {
      await this.requireStandalone()
      const account = this.requireAccount()
      return this.mobile.create(account, this.apiFactory(account.apiBaseUrl))
    })
  }
  async inspectMobileLogin(id: string): Promise<MobileLoginSnapshot> {
    await this.requireStandalone()
    return this.mobile.inspect(id, this.requireAccount())
  }
  async confirmMobileLogin(id: string, approved: boolean): Promise<MobileLoginSnapshot> {
    await this.requireStandalone()
    return this.mobile.confirm(id, approved, this.requireAccount())
  }

  private async cancelFlow(): Promise<void> {
    this.recoveryController?.abort()
    this.recoveryCheck = null
    this.recoveryController = null
    this.controller?.abort()
    if (this.work) await this.work
    this.work = null
    this.controller = null
    if (this.flow) await this.flow.close()
    this.flow = null
    if (this.stage !== 'ready' && !this.recovery) this.setProgress('idle', '可以重新开始连接。')
  }

  logout(): Promise<void> {
    this.stopResume()
    this.mobile.clear()
    return this.serial(async () => {
      await this.initialize()
      if (this.disposed) throw new Error('插件已关闭。')
      await this.logoutFlow()
    })
  }

  private async logoutFlow(): Promise<void> {
    this.mobile.clear()
    await this.cancelFlow()
    await this.connector.stop()
    this.account = null
    this.profileCheckedAt = 0
    this.binding = null
    this.recovery = null
    await rm(join(this.config.stateRoot, 'account.json'), { force: true })
    this.setProgress('idle', '已退出登录，本机连接已停止。')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopResume()
    if (this.roleTimer) clearInterval(this.roleTimer)
    this.roleTimer = null
    this.mobile.clear()
    this.unsubscribeConnector()
    this.controller?.abort()
    this.profileController.abort()
    await this.profileRefresh
    await this.roleCheck
    await this.serial(async () => {
      await this.initialized?.catch(() => undefined)
      try { await this.cancelFlow(); await this.connector.stop() } finally { await this.releaseLock?.(); this.releaseLock = null }
    })
  }

  private loseOwnership(): void {
    this.disposed = true
    this.stopResume()
    if (this.roleTimer) clearInterval(this.roleTimer)
    this.roleTimer = null
    this.mobile.clear()
    this.controller?.abort()
    this.profileController.abort()
    this.releaseLock = null
    const report = () => this.setProgress('error', '本机管理锁已失效，连接已停止。请重新加载插件。')
    void this.serial(async () => {
      try { await this.cancelFlow(); await this.connector.stop() } finally { report() }
    }).catch(report)
  }

  private refreshRole(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.roleCheck ??= (async () => {
      const desktop = await this.detect()
      if (this.disposed) return
      this.desktop = desktop
      if (desktop.status === 'absent') return
      // Installation changes are observed even when the plugin panel is closed.
      // Abort first; never await the flow from inside that same flow's guard.
      this.controller?.abort()
      this.recoveryController?.abort()
      this.mobile.clear()
      const shouldStopConnector = this.connector.running || Boolean(this.controller) || this.stage === 'starting'
      const wasActive = shouldStopConnector || Boolean(this.flow) || this.stage !== 'idle'
      if (shouldStopConnector) await this.connector.stop()
      const flow = this.flow
      this.flow = null
      if (flow) await flow.close()
      if (wasActive || this.message !== desktop.message) {
        this.setProgress('idle', desktop.message)
      }
    })().finally(() => { this.roleCheck = null })
    return this.roleCheck
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
    if (stage === 'ready' || (stage === 'idle' && !this.account)) this.connectionFailure = null
    const changed = this.stage !== stage || this.message !== message
    this.stage = stage
    this.message = message
    if (changed) {
      this.diagnostics.log(stage === 'error' ? 'warn' : 'info', 'onboarding.stage', { stage })
    }
    this.flow?.update({ stage, message })
  }

  private snapshot(): OnboardingSnapshot {
    return {
      desktop: this.desktop, settings: { ...this.settings }, stage: this.stage, message: this.message,
      account: this.account ? publicProfile(this.account) : null,
      accountExpired: Boolean(this.account && this.accountExpired(this.account)),
      webAppUrl: resolveWebAppUrl(this.settings.apiBaseUrl),
      connectorId: this.binding?.connectorId ?? null, connectorRunning: this.connector.running, flowId: this.flow?.id ?? null,
      deviceRecovery: this.recovery ? { ...this.recovery } : null,
      connector: {
        settings: this.connectorSettings.get(), resolvedUvPath: this.resolvedUvPath,
        dataPath: join(this.config.stateRoot, 'connector'), logsPath: this.connector.logsPath ?? '',
        canOpenFolders: canOpenFolders(), deviceName: this.binding?.name ?? null,
        lastError: this.connector.lastError ?? null,
      },
    }
  }
}

/** Only failures that can pass on their own are retried; everything else waits for the user. */
function canRetryResume(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500 || error.status === 408 || error.status === 429
  if (error instanceof DeviceRecoveryRequired || error instanceof ConnectorCredentialError
    || error instanceof AccountLoginRequired || error instanceof ConnectorOwnershipError) return false
  if (error instanceof Error && 'code' in error && error.code === 'CONNECTOR_SYNC_STATE_INVALID') return false
  return !(error instanceof Error && error.message === '插件已关闭。')
}

function safeMessage(error: unknown): string {
  if (error instanceof TypeError) return '无法连接服务，请检查网络和连接地址。'
  return error instanceof Error ? error.message : '连接失败，请重试。'
}
