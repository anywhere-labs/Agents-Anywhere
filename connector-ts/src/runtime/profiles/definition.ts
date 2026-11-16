// ACP Agent 定义：Connector 自带的、类型化的启动方式与差异，从不接受用户提供的命令。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/agents.py（v3 按 D10 从 v2 迁移 profile 定义）。

import type { Capability, JsonObject, RuntimeType } from '../../application/ports/runtime-session.js'
import type { AcpDialect } from '../acp/dialect.js'

/**
 * 实例配置可以从 Server 修改，所以绝不能携带启动指令；参数和环境变量只由定义决定。
 * 比较时忽略大小写。
 */
export const FORBIDDEN_CONFIG_KEYS: ReadonlySet<string> = new Set(['command', 'commands', 'args', 'arguments', 'argv', 'env', 'environment', 'launch', 'shell'])

/** 本机命令：先找 PATH，再找候选路径（Desktop 或服务拉起的 Connector 往往拿不到登录 shell 的 PATH）。 */
export interface Executable {
  readonly name: string
  readonly candidates?: readonly string[]
  /** Windows 上 npm 生成的 `.cmd` 包装脚本对应的入口（相对 node_modules），用 node 直接运行它，不经 shell。 */
  readonly windowsNpmEntry?: string
}

/** 实例配置里一个可选目录，作为环境变量传给 Agent。 */
export interface PathSetting {
  readonly key: string
  readonly title: string
  readonly environment: string
}

export interface ConfigSchema {
  readonly schema: JsonObject
  readonly uiSchema?: JsonObject
  readonly defaults?: JsonObject
}

export interface DialectContext {
  readonly instanceId: string
  readonly settings: JsonObject
}

export interface AcpAgentDefinition {
  /** 与 v2 runtime_type 一致（会话 ID、Timeline ID 的输入）。 */
  readonly runtime: RuntimeType
  readonly displayName: string
  readonly description?: string
  readonly executable: Executable
  /** 固定的 ACP 启动参数，例如 `['acp']`。 */
  readonly arguments: readonly string[]
  /** 启动前确认 ACP 入口可用的命令参数（非 0 退出即不可用）。 */
  readonly check?: readonly string[]
  /** 读版本的命令参数（取输出的最后一行）。 */
  readonly version?: readonly string[]
  /** 进程在会话工作目录里启动（每个工作目录一个进程）；否则在实例数据目录。 */
  readonly launchInWorkspace?: boolean
  /** 列出 Agent 的原生会话（`session/list`）；缺省 true（v2 `native_inventory`）。 */
  readonly nativeInventory?: boolean
  readonly settings?: readonly PathSetting[]
  /** 实例配置；不给时由 `executable` 和 `settings` 生成。 */
  readonly configSchema?: ConfigSchema
  /** 建会话前就能列出的权限选项：[值, 名称]。 */
  readonly permissionOptions?: ReadonlyArray<readonly [string, string]>
  /** 设备详情里展示的额外事实（v2 `metadata`）。 */
  readonly metadata?: JsonObject
  readonly maturity?: string
  /** 会话方言；每个运行实例一份。 */
  dialect(context: DialectContext): AcpDialect
  /** 方言之外的运行时级能力上限（附件等）。 */
  readonly extraCapabilities?: readonly Capability[]
}

/** 实例配置 schema（v2 `AcpAgentDefinition.instance_schema`）。 */
export function instanceSchema(definition: AcpAgentDefinition): ConfigSchema {
  if (definition.configSchema !== undefined) return definition.configSchema
  const properties: Record<string, JsonObject> = {
    cliPath: {
      type: 'string',
      title: `本机 ${definition.executable.name} 路径（可选）`,
      maxLength: 4096,
      metadata: { i18n: { labelKey: 'dashboard.device.runtimeConfigFields.agentCliPath.label' } },
    },
  }
  for (const setting of definition.settings ?? []) properties[setting.key] = { type: 'string', title: setting.title, maxLength: 4096 }
  return {
    schema: { type: 'object', additionalProperties: false, properties },
    uiSchema: { order: Object.keys(properties), fields: {} },
  }
}

/** 拒绝实例配置可能携带启动指令的定义（v2 `check_definition`）。 */
export function checkDefinition(definition: AcpAgentDefinition): void {
  const schema = instanceSchema(definition).schema
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const forbidden = Object.keys(properties).filter(key => FORBIDDEN_CONFIG_KEYS.has(key.toLowerCase())).sort()
  if (forbidden.length) throw new Error(`${definition.runtime}: configuration must not contain ${JSON.stringify(forbidden)}`)
  if (schema.additionalProperties !== false) throw new Error(`${definition.runtime}: configuration must reject unknown fields`)
}

/**
 * 按 schema 检查实例配置。定义生成的 schema 只有 `type: object`、`additionalProperties: false` 和
 * 带 `maxLength` 的字符串字段，这里只实现这些（不引入 JSON Schema 依赖）。报错不回显值：值里可能有凭据。
 */
export function validateSettings(schema: JsonObject, values: JsonObject): string | undefined {
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>
  for (const [key, value] of Object.entries(values)) {
    const property = properties[key]
    if (property === undefined) {
      if (schema.additionalProperties === false) return `${key} 不是可配置项`
      continue
    }
    if (property.type === 'string') {
      if (typeof value !== 'string') return `${key} 必须是字符串`
      if (typeof property.maxLength === 'number' && value.length > property.maxLength) return `${key} 超过 ${property.maxLength} 个字符`
    } else if (property.type === 'boolean' && typeof value !== 'boolean') {
      return `${key} 必须是布尔值`
    }
  }
  return undefined
}
