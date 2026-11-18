// A session's native desktop app as slash commands (application/inbound NativeAppCommandsApi): open the native
// session in the app, and quit the app holding it so this device can take over. Quitting is two calls: the first
// drafts a plan and answers `confirmation_required` with the plan's facts; only a second call naming that plan
// (`--confirm <planId>`, optionally `--force`) ends the app. `--cancel <planId>` drops the plan.

import type {
  NativeAppCommandResult,
  NativeAppCommandsApi,
  NativeAppCommandSpec,
  NativeAppCommandView,
  NativeAppPort,
  NativeSessionRef,
  OwnerReleaseOutcome,
  OwnerReleasePort,
  RuntimeHandle,
} from '../ports/index.js'

export const APP_OPEN_CAPABILITY = 'runtime.app_open'
export const OWNER_RELEASE_CAPABILITY = 'runtime.owner_release'

/** The session facts the commands need. */
export interface NativeAppSession {
  readonly runtimeId: string
  readonly externalSessionId: string | null
  readonly cwd: string | null
}

export interface NativeAppCommandsDeps {
  readonly session: (sessionId: string) => Promise<NativeAppSession | null>
  /** The session's started Runtime instance; null when it is not running (no instance is started for this). */
  readonly handle: (runtimeId: string) => Promise<RuntimeHandle | null>
}

interface AppCommands {
  readonly app: NativeAppPort
  readonly open: NativeAppCommandSpec | null
  readonly release: { readonly spec: NativeAppCommandSpec; readonly port: OwnerReleasePort } | null
}

function supported(handle: RuntimeHandle, capabilityId: string): boolean {
  return handle.capabilities().items.some(item => item.id === capabilityId && item.supported)
}

function view(spec: NativeAppCommandSpec): NativeAppCommandView {
  return { id: spec.id, title: spec.title, description: spec.description, aliases: [...spec.aliases] }
}

function names(spec: NativeAppCommandSpec): string[] {
  return [spec.id, ...spec.aliases].map(name => name.toLowerCase())
}

function failed(code: string, message: string, result: Record<string, unknown> = {}): NativeAppCommandResult {
  return { ok: false, code, message, result: { executionState: 'completed', ...result } }
}

function done(message: string, result: Record<string, unknown>): NativeAppCommandResult {
  return { ok: true, code: null, message, result: { executionState: 'completed', ...result } }
}

type ReleaseArgs = { readonly step: 'prepare' } | { readonly step: 'confirm'; readonly planId: string; readonly force: boolean } | { readonly step: 'cancel'; readonly planId: string }

function releaseArgs(args: readonly string[]): ReleaseArgs | null {
  if (args.length === 0) return { step: 'prepare' }
  const [flag, planId, ...rest] = args
  if (planId === undefined || planId === '') return null
  if (flag === '--cancel' && rest.length === 0) return { step: 'cancel', planId }
  if (flag !== '--confirm') return null
  if (rest.length === 0) return { step: 'confirm', planId, force: false }
  return rest.length === 1 && rest[0] === '--force' ? { step: 'confirm', planId, force: true } : null
}

export class NativeAppCommands implements NativeAppCommandsApi {
  /** Plans drafted for a session: a plan is confirmed only from the session it was drafted for. */
  private readonly plans = new Map<string, string>()

  public constructor(private readonly deps: NativeAppCommandsDeps) {}

  public async list(sessionId: string): Promise<readonly NativeAppCommandView[]> {
    const found = await this.find(sessionId)
    if (found === null) return []
    const { commands } = found
    return [...(commands.open !== null ? [view(commands.open)] : []), ...(commands.release !== null ? [view(commands.release.spec)] : [])]
  }

  public async execute(sessionId: string, command: string, args: readonly string[], context: { readonly takeover: boolean }): Promise<NativeAppCommandResult | null> {
    const found = await this.find(sessionId)
    if (found === null) return null
    const { commands, session } = found
    const name = command.toLowerCase()
    const appName = commands.app.appName
    if (commands.open !== null && names(commands.open).includes(name)) {
      if (args.length > 0) return failed('invalid_command', '这个命令不接受参数。')
      const ref = this.ref(session)
      if (ref === null) return failed('session_not_bound', '会话还没有对应的原生会话。')
      return this.open(commands.app, ref)
    }
    if (commands.release !== null && names(commands.release.spec).includes(name)) {
      const parsed = releaseArgs(args)
      if (parsed === null) return failed('invalid_command', '命令参数无效。')
      if (parsed.step === 'cancel') {
        if (this.plans.get(parsed.planId) === sessionId) {
          this.plans.delete(parsed.planId)
          commands.release.port.discard(parsed.planId)
        }
        return done('已取消。', { status: 'cancelled' })
      }
      if (!context.takeover) return failed('session_read_only', `会话处于只读状态，接管后才能退出 ${appName}。`)
      if (parsed.step === 'confirm') return this.confirm(sessionId, appName, commands.release.port, parsed.planId, parsed.force)
      const ref = this.ref(session)
      if (ref === null) return failed('session_not_bound', '会话还没有对应的原生会话。')
      return this.prepare(sessionId, appName, commands.release.port, ref)
    }
    return null
  }

  private ref(session: NativeAppSession): NativeSessionRef | null {
    if (session.externalSessionId === null || session.externalSessionId === '') return null
    return { nativeSessionId: session.externalSessionId, ...(session.cwd ? { cwd: session.cwd } : {}) }
  }

  private async find(sessionId: string): Promise<{ readonly session: NativeAppSession; readonly commands: AppCommands } | null> {
    const session = await this.deps.session(sessionId)
    if (session === null) return null
    const handle = await this.deps.handle(session.runtimeId)
    const app = handle?.nativeApp
    if (handle === null || handle === undefined || app === undefined) return null
    const open = supported(handle, APP_OPEN_CAPABILITY) ? app.commands.open : null
    const releaseSpec = app.commands.release
    const release = releaseSpec !== undefined && handle.ownerRelease !== undefined && supported(handle, OWNER_RELEASE_CAPABILITY)
      ? { spec: releaseSpec, port: handle.ownerRelease }
      : null
    if (open === null && release === null) return null
    return { session, commands: { app, open, release } }
  }

  private async open(app: NativeAppPort, ref: NativeSessionRef): Promise<NativeAppCommandResult> {
    const outcome = await app.open(ref)
    switch (outcome.status) {
      case 'opened':
        return done(`已在 ${app.appName} 中打开这个会话。`, { status: 'opened', appName: app.appName })
      case 'app_not_running':
        return failed('app_not_running', `${app.appName} 没有在运行，请先在这台电脑上打开它。`, { appName: app.appName })
      case 'open_failed':
        return failed('app_open_failed', `无法打开 ${app.appName}。`, { appName: app.appName })
      default:
        return failed('command_unavailable', `这台电脑不能在 ${app.appName} 中打开会话。`, { appName: app.appName })
    }
  }

  private async prepare(sessionId: string, appName: string, port: OwnerReleasePort, ref: NativeSessionRef): Promise<NativeAppCommandResult> {
    const prepared = await port.prepare(ref, { sessionId })
    if (prepared.status === 'not_needed') return done(`这个会话现在可以直接接手，不需要退出 ${appName}。`, { status: 'not_needed' })
    if (prepared.status === 'unavailable') {
      if (prepared.reason === 'owner_not_running') return failed('app_not_running', `${appName} 没有在运行。`, { appName })
      if (prepared.reason === 'process_table_unavailable') return failed('command_error', '无法读取这台电脑的进程列表。')
      return failed('command_unavailable', `这台电脑不能退出 ${appName}。`)
    }
    const { plan } = prepared
    this.plans.set(plan.planId, sessionId)
    return failed('confirmation_required', `退出 ${appName} 会释放它正在使用的所有会话，需要你确认。`, {
      confirmation: {
        kind: 'owner_release',
        planId: plan.planId,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        appName: plan.owner.displayName,
        processCount: plan.owner.processCount,
        releasesOtherSessions: plan.releasesOtherSessions,
        gracePeriodMs: plan.gracePeriodMs,
        confirmArgs: ['--confirm', plan.planId],
        forceArgs: ['--confirm', plan.planId, '--force'],
        cancelArgs: ['--cancel', plan.planId],
      },
    })
  }

  private async confirm(sessionId: string, appName: string, port: OwnerReleasePort, planId: string, force: boolean): Promise<NativeAppCommandResult> {
    if (this.plans.get(planId) !== sessionId) return failed('plan_expired', '确认已过期，请重新执行。', { status: 'plan_expired' })
    this.plans.delete(planId)
    return released(appName, await port.execute(planId, { force }))
  }
}

function released(appName: string, outcome: OwnerReleaseOutcome): NativeAppCommandResult {
  const status = { status: outcome.status }
  switch (outcome.status) {
    case 'released':
      return done(`已退出 ${appName}。发送下一条消息即可由 Agents Anywhere 接手这个会话。`, status)
    case 'already_released':
      return done('会话已经被释放，发送下一条消息即可接手。', status)
    case 'plan_expired':
    case 'plan_changed':
      return failed(outcome.status, `确认已过期或 ${appName} 的进程已变化，请重新执行。`, status)
    case 'survivors':
      return failed('survivors', `${appName} 没有在等待时间内退出。可以重新执行并选择强制结束。`, status)
    case 'still_held':
      return failed('still_held', `${appName} 已退出，但会话仍被占用。`, status)
  }
}
