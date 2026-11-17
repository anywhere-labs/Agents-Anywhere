/**
 * DSH runtime provider: one `DshRuntime` per instance, serving the direct route (DSH's automation
 * ACP, started on demand) and every plugin host the Connector's local socket hands it
 * (`DshRuntime.attachHost`).
 */
import { processConnection, type ConnectionFactory } from '../../acp/handle.js'
import { dshDirectDialect } from './direct/dialect.js'
import { dshEnvironment, resolveDshLaunch, systemProbe, type DshLaunchPlan, type LaunchProbe } from './launcher.js'
import { DshRuntime } from './runtime.js'
import { dshHomeOf, type DshSessionIds } from './session-ids.js'

export interface DshProviderFacts {
  installed: boolean
  version?: string
  detail: Record<string, unknown>
}

export interface DshInstanceSettings {
  /** Full override of the launch command (advanced). */
  command?: string
  args?: string[]
  dshHome?: string
  /** AA model gateway handed to DSH through its launching environment. */
  model?: { apiKey?: string, baseUrl?: string }
  allowNpx?: boolean
}

export function parseDshSettings(settings: Record<string, unknown>): DshInstanceSettings {
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined
  const model = settings.model && typeof settings.model === 'object' ? settings.model as Record<string, unknown> : {}
  const command = text(settings.command)
  const dshHome = text(settings.dshHome)
  const apiKey = text(model.apiKey)
  const baseUrl = text(model.baseUrl)
  return {
    ...(command ? { command } : {}),
    ...(Array.isArray(settings.args) ? { args: settings.args.filter((item): item is string => typeof item === 'string') } : {}),
    ...(dshHome ? { dshHome } : {}),
    ...(apiKey || baseUrl ? { model: { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) } } : {}),
    ...(settings.allowNpx === false ? { allowNpx: false } : {}),
  }
}

export interface DshProviderDeps {
  probe?: LaunchProbe
  env?: NodeJS.ProcessEnv
  /** `dsh` executables bundled with DSH Desktop, as the host knows them. */
  desktopExecutables?: readonly string[]
  /** Working directory of the direct-route process. */
  cwd?: string
  /** Test seam: how a launch plan becomes an ACP connection (default: start the process). */
  connect?: (plan: DshLaunchPlan, env: NodeJS.ProcessEnv) => ConnectionFactory
}

export class DshProvider {
  readonly type = 'dsh' as const
  constructor(private readonly deps: DshProviderDeps = {}) {}

  private launchOptions(settings: DshInstanceSettings) {
    return {
      ...(settings.command ? { configured: { command: settings.command, ...(settings.args ? { args: settings.args } : {}) } } : {}),
      ...(this.deps.desktopExecutables ? { desktopExecutables: this.deps.desktopExecutables } : {}),
      ...(settings.allowNpx === false ? { allowNpx: false } : {}),
      platform: process.platform,
    }
  }

  /** Whether the direct route can start (a plugin host can serve without it). */
  async discover(settings: Record<string, unknown> = {}): Promise<DshProviderFacts> {
    try {
      const plan = await resolveDshLaunch(this.launchOptions(parseDshSettings(settings)), this.deps.probe ?? systemProbe(this.deps.env))
      return { installed: true, ...(plan.version ? { version: plan.version } : {}), detail: { route: 'direct', source: plan.source } }
    } catch (error) {
      return { installed: false, detail: { route: 'direct', reason: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** The instance's runtime. Without a launchable `dsh` it serves plugin hosts only. */
  async start(instance: { runtimeId: string, settings: Record<string, unknown>, ids?: DshSessionIds }): Promise<DshRuntime> {
    const settings = parseDshSettings(instance.settings)
    let plan: DshLaunchPlan | undefined
    try { plan = await resolveDshLaunch(this.launchOptions(settings), this.deps.probe ?? systemProbe(this.deps.env)) } catch { plan = undefined }
    const env = dshEnvironment(this.deps.env ?? process.env, { ...(settings.dshHome ? { dshHome: settings.dshHome } : {}), ...(settings.model ? { model: settings.model } : {}) })
    const direct = plan && this.deps.connect ? this.deps.connect(plan, env) : plan ? processConnection({ command: plan.command, args: plan.args, cwd: this.deps.cwd ?? process.cwd(), env }, dshDirectDialect(),
      { initializeTimeoutMs: plan.source === 'npx' ? 180_000 : 30_000 }) : undefined
    return new DshRuntime({ instanceId: instance.runtimeId, ...(direct ? { direct } : {}), ...(instance.ids ? { ids: instance.ids } : {}),
      dshHome: dshHomeOf(settings, this.deps.env ?? process.env) })
  }
}
