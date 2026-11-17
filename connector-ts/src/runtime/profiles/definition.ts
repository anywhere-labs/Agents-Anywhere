// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/agents.py @98dd0e6e5 (profile definitions)
//
// ACP Agent definitions: typed launch methods and differences shipped with the Connector; user-provided commands
// are never accepted.

import type { Capability, ConfigOption, JsonObject, ModelGatewayConfig, RuntimeInstanceConfig, RuntimeType } from '../../application/ports/runtime-session.js'
import type { ProtocolPermissionItem } from '../../generated/protocol/v1_2/permission-catalog-response.js'
import type { AcpDialect } from '../acp/dialect.js'
import type { LocalLaunch, Platform } from './launch.js'

/**
 * Instance config can be changed from the Server, so it must never carry launch instructions; arguments and
 * environment variables are decided by the definition alone. Compared case-insensitively.
 */
export const FORBIDDEN_CONFIG_KEYS: ReadonlySet<string> = new Set(['command', 'commands', 'args', 'arguments', 'argv', 'env', 'environment', 'launch', 'shell'])

/**
 * Local command: looked up on PATH first, then in candidate paths (a Connector launched by Desktop or a service
 * often lacks the login shell's PATH).
 */
export interface Executable {
  readonly name: string
  readonly candidates?: readonly string[]
  /**
   * Entry behind the `.cmd` wrapper npm generates on Windows (relative to node_modules); run directly with node,
   * not through a shell.
   */
  readonly windowsNpmEntry?: string
}

/** An optional directory in instance config, passed to the Agent as an environment variable. */
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

/** Input to the launch preparation hook. */
export interface LaunchContext {
  readonly instanceId: string
  readonly sessionNamespace: string
  /** Validated instance config. */
  readonly settings: JsonObject
  /**
   * Model gateway: injected by the definition as environment variables or private config, never passed through as
   * env from instance config.
   */
  readonly modelGateway?: ModelGatewayConfig
  /** Instance data directory (process working directory, private cache). */
  readonly dataDir: string
  /** Working directory, when processes are split per working directory. */
  readonly scope?: { readonly cwd: string }
  readonly platform?: Platform
}

export interface AcpAgentDefinition {
  /** Runtime type; an input to session IDs and Timeline IDs, so it must stay stable. */
  readonly runtime: RuntimeType
  readonly displayName: string
  readonly description?: string
  readonly executable: Executable
  /** Fixed ACP launch arguments, e.g. `['acp']`. */
  readonly arguments: readonly string[]
  /** Arguments that confirm the ACP entry works before launch (a non-zero exit means unavailable). */
  readonly check?: readonly string[]
  /** Arguments that read the driven Agent's version (the last line of output is used). */
  readonly version?: readonly string[]
  /**
   * Arguments that read the adapter version (when the executable is an adapter with the Agent inside it, e.g.
   * claude-agent-acp).
   */
  readonly adapterVersion?: readonly string[]
  /** Start the process in the session's working directory (one process per directory); otherwise in the instance data directory. */
  readonly launchInWorkspace?: boolean
  /** List the Agent's native sessions (`session/list`); defaults to true. */
  readonly nativeInventory?: boolean
  readonly settings?: readonly PathSetting[]
  /** Instance config; generated from `executable` and `settings` when not given. */
  readonly configSchema?: ConfigSchema
  /** Permission options that can be listed before a session exists: [value, name]. */
  readonly permissionOptions?: ReadonlyArray<readonly [string, string]>
  /** Full permission catalog (with catalog metadata), optionally filtered by the session config; takes precedence over permissionOptions. */
  permissionCatalog?(config: readonly ConfigOption[]): readonly ProtocolPermissionItem[]
  /** Extra facts shown in device details. */
  readonly metadata?: JsonObject
  readonly maturity?: string
  /**
   * Adjusts the Agent process environment after the generic environment boundary (supervisor/environment.ts):
   * removes variables inherited from a host and injects the model gateway. Variables mapped from settings are
   * merged afterwards and are not removed by it.
   */
  environment?(env: NodeJS.ProcessEnv, instance: RuntimeInstanceConfig): NodeJS.ProcessEnv
  /** Session dialect; one per running instance. */
  dialect(context: DialectContext): AcpDialect
  /**
   * Launch preparation: when the Agent is not a ready-made local executable (e.g. an npm runtime must be installed
   * first or the adapter patched), this supplies the command, arguments and environment before each process start;
   * without it the local command is found from `executable` (`localLaunch`). The returned command and arguments are
   * still decided by the definition alone; instance config cannot carry them.
   */
  prepareLaunch?(context: LaunchContext): Promise<LocalLaunch>
  /**
   * How long a process with no sessions stays idle before it is reclaimed; 0 keeps it running (Codex: codex-acp keeps
   * following Codex App sessions). Defaults to the process pool's default.
   */
  readonly idleMs?: number
  /** Runtime-level capability limits outside the dialect (attachments, etc.). */
  readonly extraCapabilities?: readonly Capability[]
  /** Prepares workspaces: the Agent session opens when the new-session page picks a directory, before the first message. */
  readonly workspacePreparation?: boolean
}

/** Instance config schema. */
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

/** Rejects a definition whose instance config could carry launch instructions. */
export function checkDefinition(definition: AcpAgentDefinition): void {
  const schema = instanceSchema(definition).schema
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const forbidden = Object.keys(properties).filter(key => FORBIDDEN_CONFIG_KEYS.has(key.toLowerCase())).sort()
  if (forbidden.length) throw new Error(`${definition.runtime}: configuration must not contain ${JSON.stringify(forbidden)}`)
  if (schema.additionalProperties !== false) throw new Error(`${definition.runtime}: configuration must reject unknown fields`)
}

/**
 * Checks instance config against the schema. Schemas generated by definitions only use `type: object`,
 * `additionalProperties: false` and string fields with `maxLength`, so only those are implemented (no JSON Schema
 * dependency). Errors never echo the value: it may contain credentials.
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
