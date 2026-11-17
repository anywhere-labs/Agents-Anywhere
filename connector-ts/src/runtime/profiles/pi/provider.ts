// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/provider.py @98dd0e6e5 (PiProvider)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/definition.py @98dd0e6e5 (runtime)
//
// Pi as a RuntimeProvider: discovery, instance config validation, and a PiRuntimeHandle on start.

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { JsonObject, ModelGatewayConfig, ProviderFacts, RuntimeInstanceConfig, RuntimeProvider } from '../../../application/ports/runtime-session.js'
import { fail, RuntimeFailure } from '../../acp/errors.js'
import { checkDefinition, instanceSchema, validateSettings, type ConfigSchema, type LaunchContext } from '../definition.js'
import { PI } from './definition.js'
import { PiRuntimeHandle, type PiConnect } from './handle.js'
import { resolveLocal, type PiInstallation } from './installation.js'
import { PiLaunchCache, piLayout, preparePiLaunch, type PiLaunchOptions } from './launch.js'
import { normalizePiSettings, type PiSettings } from './settings.js'

export interface PiProviderOptions {
  /**
   * Connector data directory; Pi's instance directories and npm / adapter caches live under `<dataDir>/pi`.
   * Defaults to `~/.agents-anywhere/connector`.
   */
  readonly dataDir?: string
  /** How long an idle session process lives before it is reclaimed (ms). */
  readonly idleMs?: number
  readonly lockDir?: string
  readonly onStderr?: (instanceId: string, line: string) => void
  /** Test overrides: local pi resolution, process connection, environment variables, gateway fetch. */
  readonly resolveLocal?: (settings: JsonObject) => Promise<PiInstallation>
  readonly connect?: PiConnect
  readonly env?: NodeJS.ProcessEnv
  readonly fetch?: typeof fetch
}

export class PiProvider implements RuntimeProvider {
  readonly type = 'pi'
  readonly definition = PI
  private readonly cache = new PiLaunchCache()

  constructor(private readonly options: PiProviderOptions = {}) {
    checkDefinition(PI)
  }

  private get dataDir(): string {
    return this.options.dataDir ?? join(homedir(), '.agents-anywhere', 'connector')
  }

  /**
   * Does not start Pi: the managed environment can always be prepared. Reports the local pi version when found;
   * otherwise reports it as a notice (the managed environment still works).
   */
  async discover(): Promise<ProviderFacts> {
    const base = {
      type: this.type,
      displayName: PI.displayName,
      configSchema: instanceSchema(PI).schema,
      instancePolicy: 'multiple' as const,
      processScope: 'perSession' as const,
      installed: true,
    }
    try {
      const local = await (this.options.resolveLocal ?? (settings => resolveLocal(settings, this.options.env ? { env: this.options.env } : {})))({})
      return { ...base, agentVersion: local.version, problems: [] }
    } catch (error) {
      if (!(error instanceof RuntimeFailure)) throw error
      return { ...base, problems: [error.error] }
    }
  }

  instanceSchema(): ConfigSchema {
    return instanceSchema(PI)
  }

  /** Validates instance config (schema plus the rules combining execution mode and model gateway). Errors never echo values. */
  validateSettings(settings: JsonObject, modelGateway?: ModelGatewayConfig): PiSettings {
    const schema = instanceSchema(PI)
    const problem = validateSettings(schema.schema, settings)
    if (problem !== undefined) fail('invalid_config', problem)
    return normalizePiSettings({ ...(schema.defaults ?? {}), ...settings }, modelGateway)
  }

  async start(instance: RuntimeInstanceConfig): Promise<PiRuntimeHandle> {
    const settings = this.validateSettings(instance.settings, instance.modelGateway)
    const context: LaunchContext = {
      instanceId: instance.instanceId,
      sessionNamespace: instance.sessionNamespace,
      settings: instance.settings,
      dataDir: this.dataDir,
      ...(instance.modelGateway ? { modelGateway: instance.modelGateway } : {}),
    }
    const layout = piLayout(context, settings, this.options.env)
    const launchOptions: PiLaunchOptions = {
      cache: this.cache,
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.resolveLocal ? { resolveLocal: this.options.resolveLocal } : {}),
    }
    const onStderr = this.options.onStderr
    return new PiRuntimeHandle({
      instanceId: instance.instanceId,
      settings,
      layout,
      launch: () => preparePiLaunch(context, launchOptions),
      // The managed environment downloads Node and npm packages the first time: prepare in the background without
      // blocking start. Local mode prepares only when needed.
      warmUp: layout.managed && this.options.connect === undefined,
      ...(this.options.connect ? { connect: this.options.connect } : {}),
      ...(this.options.idleMs !== undefined ? { idleMs: this.options.idleMs } : {}),
      ...(this.options.lockDir !== undefined ? { lockDir: this.options.lockDir } : {}),
      ...(onStderr ? { onStderr: (line: string) => onStderr(instance.instanceId, line) } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    })
  }
}

export function piProvider(options: PiProviderOptions = {}): PiProvider {
  return new PiProvider(options)
}
