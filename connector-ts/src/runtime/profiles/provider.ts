// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/provider.py @98dd0e6e5 (AcpAgentProvider)
//
// An ACP Agent definition as a RuntimeProvider: discovery, instance config validation and on-demand process start.

import { homedir } from 'node:os'

import type {
  JsonObject,
  ProviderFacts,
  RuntimeInstanceConfig,
  RuntimeProvider,
  RuntimeType,
} from '../../application/ports/runtime-session.js'
import { fail, RuntimeFailure } from '../acp/errors.js'
import { AcpRuntimeHandle, processConnection } from '../acp/handle.js'
import { agentEnvironment } from '../supervisor/environment.js'
import { checkDefinition, instanceSchema, validateSettings, type AcpAgentDefinition, type ConfigSchema } from './definition.js'
import { launchCommand, localLaunch, resolveExecutable, runCheck, type Platform } from './launch.js'

export interface AcpAgentProviderOptions {
  /** Process working directory (the runtime root); defaults to the user's home directory. */
  readonly dataDir?: string
  readonly idleMs?: number
  readonly onStderr?: (instanceId: string, line: string) => void
  /** Platform facts replaced by tests. */
  readonly platform?: Platform
}

export class AcpAgentProvider implements RuntimeProvider {
  readonly type: RuntimeType

  constructor(readonly definition: AcpAgentDefinition, private readonly options: AcpAgentProviderOptions = {}) {
    checkDefinition(definition)
    this.type = definition.runtime
  }

  /** Does not start the Agent: only finds the executable and reads versions. The ACP entry check waits until a real start. */
  async discover(): Promise<ProviderFacts> {
    const base = {
      type: this.type,
      displayName: this.definition.displayName,
      configSchema: instanceSchema(this.definition).schema,
      instancePolicy: 'multiple' as const,
      processScope: 'shared' as const,
    }
    try {
      const path = resolveExecutable(this.definition, {}, this.options.platform)
      const command = launchCommand(this.definition, path, this.options.platform)
      const read = async (args: readonly string[] | undefined) => (args
        ? (await runCheck(this.definition, command, args, {}, this.options.platform)).split('\n').map(line => line.trim()).filter(Boolean).at(-1)
        : undefined)
      const agentVersion = await read(this.definition.version)
      const adapterVersion = await read(this.definition.adapterVersion)
      return { ...base, installed: true, ...(agentVersion !== undefined ? { agentVersion } : {}), ...(adapterVersion !== undefined ? { adapterVersion } : {}), problems: [] }
    } catch (error) {
      if (!(error instanceof RuntimeFailure)) throw error
      return { ...base, installed: error.error.code !== 'agent_cli_missing', problems: [error.error] }
    }
  }

  instanceSchema(): ConfigSchema {
    return instanceSchema(this.definition)
  }

  /** Validates instance config. Errors never echo values. */
  validateSettings(settings: JsonObject): JsonObject {
    const schema = instanceSchema(this.definition)
    const problem = validateSettings(schema.schema, settings)
    if (problem !== undefined) fail('invalid_config', problem)
    return { ...(schema.defaults ?? {}), ...settings }
  }

  /** Process environment: generic boundary -> definition's adjustments -> variables mapped from settings. */
  environment(fromSettings: Readonly<Record<string, string>>, instance: RuntimeInstanceConfig): NodeJS.ProcessEnv {
    const base = agentEnvironment({}, this.options.platform ? { base: this.options.platform.env } : {})
    const adjusted = this.definition.environment ? this.definition.environment(base, instance) : base
    return { ...adjusted, ...fromSettings }
  }

  async start(instance: RuntimeInstanceConfig): Promise<AcpRuntimeHandle> {
    const settings = this.validateSettings(instance.settings)
    const definition = this.definition
    const dialect = definition.dialect({ instanceId: instance.instanceId, settings })
    const cwd = this.options.dataDir ?? this.options.platform?.home ?? homedir()
    const onStderr = this.options.onStderr
    return new AcpRuntimeHandle({
      type: definition.runtime,
      instanceId: instance.instanceId,
      dialect,
      // Resolve and check again before every process start: the user may have just upgraded or removed the Agent.
      connect: async scope => {
        const launch = definition.prepareLaunch
          ? await definition.prepareLaunch({
            instanceId: instance.instanceId, sessionNamespace: instance.sessionNamespace, settings, dataDir: cwd,
            ...(instance.modelGateway ? { modelGateway: instance.modelGateway } : {}),
            ...(scope ? { scope } : {}),
            ...(this.options.platform ? { platform: this.options.platform } : {}),
          })
          : await localLaunch(definition, settings, this.options.platform)
        return processConnection(
          { command: launch.command, args: launch.args, cwd: definition.launchInWorkspace && scope ? scope.cwd : cwd, env: this.environment(launch.environment, instance) },
          dialect,
          onStderr ? { onStderr: line => onStderr(instance.instanceId, line) } : {},
        )()
      },
      ...((this.options.idleMs ?? definition.idleMs) !== undefined ? { idleMs: (this.options.idleMs ?? definition.idleMs)! } : {}),
      ...(definition.permissionOptions ? { permissionOptions: definition.permissionOptions } : {}),
      ...(definition.permissionCatalog ? { permissionCatalog: definition.permissionCatalog } : {}),
      ...(definition.nativeInventory === false ? { nativeInventory: false } : {}),
      ...(definition.launchInWorkspace ? { processPerWorkspace: true } : {}),
      ...(definition.workspacePreparation === true ? { workspacePreparation: true } : {}),
    })
  }
}
