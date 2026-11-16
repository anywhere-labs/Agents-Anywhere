// 一个 ACP Agent 定义作为 RuntimeProvider：发现、实例配置校验、按需启动进程。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/provider.py

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
import { checkDefinition, instanceSchema, validateSettings, type AcpAgentDefinition } from './definition.js'
import { launchCommand, localLaunch, resolveExecutable, runCheck, type Platform } from './launch.js'

export interface AcpAgentProviderOptions {
  /** 进程工作目录（v2 的 runtime root）；缺省用户主目录。 */
  readonly dataDir?: string
  readonly idleMs?: number
  readonly onStderr?: (instanceId: string, line: string) => void
  /** 测试替换平台信息。 */
  readonly platform?: Platform
}

export class AcpAgentProvider implements RuntimeProvider {
  readonly type: RuntimeType

  constructor(readonly definition: AcpAgentDefinition, private readonly options: AcpAgentProviderOptions = {}) {
    checkDefinition(definition)
    this.type = definition.runtime
  }

  /** 不启动 Agent：只找可执行文件、读版本。ACP 入口检查放到真正启动前。 */
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
      let agentVersion: string | undefined
      if (this.definition.version) {
        const command = launchCommand(this.definition, path, this.options.platform)
        const output = await runCheck(this.definition, command, this.definition.version, {}, this.options.platform)
        agentVersion = output.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
      }
      return { ...base, installed: true, ...(agentVersion !== undefined ? { agentVersion } : {}), problems: [] }
    } catch (error) {
      if (!(error instanceof RuntimeFailure)) throw error
      return { ...base, installed: error.error.code !== 'agent_cli_missing', problems: [error.error] }
    }
  }

  /** 校验实例配置（v2 `validate_config`）。报错不回显值。 */
  validateSettings(settings: JsonObject): JsonObject {
    const schema = instanceSchema(this.definition)
    const problem = validateSettings(schema.schema, settings)
    if (problem !== undefined) fail('invalid_config', problem)
    return { ...(schema.defaults ?? {}), ...settings }
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
      // 每次拉起进程前重新解析和检查（v2 `validated_launch`）：用户可能刚升级或卸载了 Agent。
      connect: async scope => {
        const launch = await localLaunch(definition, settings, this.options.platform)
        return processConnection(
          { command: launch.command, args: launch.args, cwd: definition.launchInWorkspace && scope ? scope.cwd : cwd, env: agentEnvironment(launch.environment, this.options.platform ? { base: this.options.platform.env } : {}) },
          dialect,
          onStderr ? { onStderr: line => onStderr(instance.instanceId, line) } : {},
        )()
      },
      ...(this.options.idleMs !== undefined ? { idleMs: this.options.idleMs } : {}),
      ...(definition.permissionOptions ? { permissionOptions: definition.permissionOptions } : {}),
      ...(definition.nativeInventory === false ? { nativeInventory: false } : {}),
      ...(definition.launchInWorkspace ? { processPerWorkspace: true } : {}),
    })
  }
}
