import {
  acpNativeInventorySessionId,
  claudeStableSessionId,
  codexStableSessionId,
  piNativeSessionId,
  sessionNamespace,
  type SourceKey,
} from '../../domain/identity/index.js'
import type { JsonObject, ModelGatewayConfig, NativeSessionSummary } from '../ports/index.js'

/**
 * One Runtime instance on this device. The legacy instance of a type has
 * `runtimeId === runtimeType` and empty settings; named instances come from the Server's desired state.
 */
export interface RuntimeInstanceSpec {
  readonly runtimeId: string
  readonly runtimeType: string
  readonly settings: JsonObject
  readonly sourceKey: SourceKey | null
  readonly enabled: boolean
  readonly modelGateway?: ModelGatewayConfig
  readonly name?: string
  /** The Server's revision of this desired state; a command with a lower one is stale. */
  readonly revision?: number
}

/**
 * The config field in which the Server keeps a model gateway (`{baseUrl, apiKey, protocol?}`, Runtime Control 2.x
 * `modelConnection.configField`). The device takes it as `RuntimeInstanceConfig.modelGateway`, never as a setting.
 */
export const GATEWAY_FIELD = 'modelGateway'

/**
 * The gateway protocols each Runtime type takes, first the default (a gateway kept in config names its protocol
 * only when there is more than one).
 */
export const GATEWAY_RUNTIME_PROTOCOLS: Readonly<Record<string, readonly ModelGatewayConfig['protocol'][]>> = {
  claude: ['anthropic'],
  pi: ['openai-chat'],
}

const GATEWAY_PROTOCOLS: Readonly<Record<string, ModelGatewayConfig['protocol']>> = {
  anthropic: 'anthropic',
  'openai-responses': 'openai-responses',
  openai_responses: 'openai-responses',
  'openai-chat': 'openai-chat',
  openai_chat: 'openai-chat',
}

/**
 * The Conversation id of a discovered native session, with the v2 identity rules of each Runtime type, so a
 * device upgraded from v2 keeps its session ids.
 */
export function nativeSessionId(connectorId: string, spec: RuntimeInstanceSpec, summary: NativeSessionSummary): string {
  const namespace = sessionNamespace({ connectorId, runtimeType: spec.runtimeType, runtimeId: spec.runtimeId, sourceKey: spec.sourceKey })
  switch (spec.runtimeType) {
    case 'codex':
      return codexStableSessionId(namespace, summary.nativeSessionId)
    case 'claude':
      return claudeStableSessionId(namespace, summary.nativeSessionId)
    case 'pi':
      return piNativeSessionId(spec.runtimeId, summary.locator ?? '', summary.nativeSessionId)
    default:
      return acpNativeInventorySessionId(spec.runtimeId, summary.nativeSessionId)
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function gatewayFrom(value: unknown, keyField: 'authToken' | 'apiKey', runtimeType: string): ModelGatewayConfig | null {
  const gateway = object(value)
  const baseUrl = text(gateway?.baseUrl)
  const authToken = text(gateway?.[keyField])
  const named = text(gateway?.protocol)
  const protocol = named !== null ? GATEWAY_PROTOCOLS[named] : GATEWAY_RUNTIME_PROTOCOLS[runtimeType]?.[0]
  if (baseUrl === null || authToken === null || protocol === undefined) return null
  const model = text(gateway?.model)
  return { baseUrl, authToken, protocol, ...(model !== null ? { model } : {}) }
}

/**
 * One desired Runtime instance: an item of `LinkWelcome.desired.runtimes`, or the payload of `runtime.apply` /
 * `channel.switch`. The Server's fields are `{runtimeId, runtimeType, name, active, config, revision?, modelGateway?}`
 * (`device_runtime_entry`); `enabled` / `settings` / `values` are still read for older callers. Anything else is
 * dropped, so an unknown entry never reaches a provider.
 *
 * - `config` is the instance's settings. A gateway the Server kept inside it (`config.modelGateway`, as the
 *   welcome's raw rows have it) becomes `modelGateway` and leaves the settings.
 * - The legacy instance of a type the user never configured (`config: null`) keeps the device's default: it
 *   stays enabled with empty settings, so native sessions keep being found. A configured one follows `active`.
 */
export function runtimeSpecFrom(item: unknown): RuntimeInstanceSpec | null {
  const record = object(item)
  if (record === null) return null
  const runtimeId = text(record.runtimeId)
  const runtimeType = text(record.runtimeType)
  if (runtimeId === null || runtimeType === null) return null
  const source = object(record.sourceKey)
  const kind = text(source?.kind)
  const key = text(source?.key)
  const unconfigured = 'config' in record && record.config === null
  const raw = object(record.config) ?? object(record.settings) ?? object(record.values) ?? {}
  const { [GATEWAY_FIELD]: keptGateway, ...settings } = raw
  const gateway = gatewayFrom(record.modelGateway, 'authToken', runtimeType) ?? gatewayFrom(keptGateway, 'apiKey', runtimeType)
  const name = text(record.name)
  const revision = typeof record.revision === 'number' && Number.isSafeInteger(record.revision) ? record.revision : null
  const enabled = unconfigured && runtimeId === runtimeType ? true : (record.active ?? record.enabled) !== false
  return {
    runtimeId,
    runtimeType,
    settings: settings as JsonObject,
    sourceKey: kind !== null && key !== null ? { kind, key } : null,
    enabled: unconfigured && runtimeId !== runtimeType ? false : enabled,
    ...(gateway !== null ? { modelGateway: gateway } : {}),
    ...(name !== null ? { name } : {}),
    ...(revision !== null ? { revision } : {}),
  }
}

/** The fence of a `channel.switch` payload: the instance and the Server's switch revision, when given. */
export function switchFenceOf(item: unknown): { readonly runtimeId: string | null; readonly revision: number | null } {
  const record = object(item) ?? {}
  return { runtimeId: text(record.runtimeId), revision: typeof record.switchRevision === 'number' ? record.switchRevision : null }
}

/** What applying one instance left behind (the `runtime.apply` result body). */
export interface InstanceReport {
  readonly runtimeId: string
  readonly status: 'running' | 'stopped' | 'error'
  readonly error?: { readonly code: string; readonly message: string }
  readonly revision?: number
  /** The desired state was older than the one applied; nothing changed. */
  readonly stale?: boolean
}

/** A coded rejection (`CommandAck.e.code`); `errorCode` in application/inbound reads `code`. */
export class RuntimeApplyError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'RuntimeApplyError'
  }
}

/** The legacy instance of a Runtime id this device has no spec for (sessions recorded before it was configured). */
export function legacyInstanceSpec(runtimeId: string): RuntimeInstanceSpec {
  return { runtimeId, runtimeType: runtimeId, settings: {}, sourceKey: null, enabled: true }
}
