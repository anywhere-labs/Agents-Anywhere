/**
 * DSH runtime provider. DSH-1 ships the direct route only; the plugin route and the
 * switch between them (DSH-4/5) plug in behind the same provider.
 */
import { DshDirectRoute } from './direct/route.js'
import { dshEnvironment, resolveDshLaunch, systemProbe, type LaunchProbe } from './launcher.js'
import type { ProviderFacts, RuntimeInstanceConfig, RuntimeProvider } from './port.js'

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
}

export class DshDirectProvider implements RuntimeProvider {
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

  async discover(settings: Record<string, unknown> = {}): Promise<ProviderFacts> {
    try {
      const plan = await resolveDshLaunch(this.launchOptions(parseDshSettings(settings)), this.deps.probe ?? systemProbe(this.deps.env))
      return { installed: true, ...(plan.version ? { version: plan.version } : {}), detail: { route: 'direct', source: plan.source } }
    } catch (error) {
      return { installed: false, detail: { route: 'direct', reason: error instanceof Error ? error.message : String(error) } }
    }
  }

  async start(instance: RuntimeInstanceConfig): Promise<DshDirectRoute> {
    const settings = parseDshSettings(instance.settings)
    const plan = await resolveDshLaunch(this.launchOptions(settings), this.deps.probe ?? systemProbe(this.deps.env))
    return DshDirectRoute.start({ plan, env: dshEnvironment(this.deps.env ?? process.env,
      { ...(settings.dshHome ? { dshHome: settings.dshHome } : {}), ...(settings.model ? { model: settings.model } : {}) }) })
  }
}
