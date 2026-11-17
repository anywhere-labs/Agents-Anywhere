// Runtime Control 3.0 on the device (contracts/runtime-control/3.0): the Server's desired state arrives as
// `aa.device.v1.Commands/*` (`runtime.apply`, `channel.switch`, `device.settings.apply`; contracts/device-meshcall/1.0)
// or in `LinkWelcome.desired`, and what the device has goes back as `runtime.status` on `Link/attach`:
//
// - `{runtimeId: '*', status: {event: 'runtime.types', runtimeTypes, features}}`: the Runtime types this build ships,
//   as Runtime Control 2.x descriptors (the shape `runtime.discover` returns in 2.x). It replaces discovery.
// - `{runtimeId, status: {..facts, instance: {status, error?}}, capabilities?}`: each instance after it was applied.
//
// The command payloads and results are declared here until the device-meshcall contract carries them.

import type { ProtocolCapabilitySet } from '../../generated/protocol/v1_2/capability-set.js'
import type { ContractStatusOf, JsonObject, LiveEvents, Log, ProviderFacts, RuntimeProvider } from '../ports/index.js'
import { capabilitySet } from './capabilities.js'
import { GATEWAY_FIELD, GATEWAY_RUNTIME_PROTOCOLS, RuntimeApplyError, runtimeSpecFrom, type InstanceReport, type RuntimeInstanceSpec } from './instances.js'
import type { RuntimeRegistry } from './registry.js'

/** `runtime.apply` / `channel.switch` payload (`device_runtime_entry` on the Server). */
export interface RuntimeApplyPayload {
  readonly runtimeId: string
  readonly runtimeType: string
  readonly name?: string
  readonly active: boolean
  /** The instance's settings; null for a legacy instance the user never configured. */
  readonly config: Record<string, unknown> | null
  readonly revision?: number
  readonly modelGateway?: { readonly baseUrl: string; readonly authToken: string; readonly protocol: string; readonly model?: string }
  /** `channel.switch` only (the Server's switch fence). */
  readonly operationId?: string
  readonly switchRevision?: number
}

/** `runtime.apply` / `channel.switch` result (`CommandAck.r`). */
export interface RuntimeApplyResult extends InstanceReport {
  /** This Connector process; a new one means the device restarted. */
  readonly instanceId: string
  readonly capabilities?: ProtocolCapabilitySet
  /** Runtime Control 2.x model connection report, for types that take a gateway. */
  readonly modelConnection?: ModelConnectionReport
}

/** `device.settings.apply` payload: the whole settings object, as `LinkWelcome.desired.deviceSettings`. */
export interface DeviceSettingsApplyPayload {
  readonly settings: Record<string, unknown>
}

type ModelConnectionReport = {
  readonly state: 'applied' | 'not_configured'
  readonly protocol: string | null
  readonly scope: 'instance'
  readonly mode: null
  readonly reason: null
  readonly externalOwner: null
}

/** Runtime Control 2.x features the Server may rely on. */
export const RUNTIME_CONTROL_FEATURES: readonly string[] = ['channelReconcileFence']

/** Runtime Control 2.x protocol names (`openai_chat`) of the gateway protocols a type takes. */
function serverProtocols(runtimeType: string): string[] {
  return (GATEWAY_RUNTIME_PROTOCOLS[runtimeType] ?? []).map(protocol => protocol.replace('-', '_'))
}

/**
 * Types that take a model gateway (`ModelConnectionCapability`): the Server keeps the gateway in
 * `config.modelGateway` and the device injects it as `RuntimeInstanceConfig.modelGateway`. Claude takes Anthropic;
 * Pi only in its managed environment (its settings check refuses the other modes).
 */
const MODEL_CONNECTIONS: Readonly<Record<string, JsonObject>> = {
  claude: {
    maturity: 'beta',
    configField: GATEWAY_FIELD,
    protocols: serverProtocols('claude'),
    modes: [],
    scope: 'instance',
    catalog: { auto: false, manual: true },
    apply: 'restart',
  },
  pi: {
    maturity: 'beta',
    configField: GATEWAY_FIELD,
    protocols: serverProtocols('pi'),
    modeField: 'executionMode',
    modes: [
      { id: 'managed', supported: true },
      { id: 'local', supported: false, reason: '本机模式使用 Pi 自己的模型配置，要用网关请切换到 AA 受管环境。' },
      { id: 'auto', supported: false, reason: '本机模式使用 Pi 自己的模型配置，要用网关请切换到 AA 受管环境。' },
    ],
    scope: 'instance',
    catalog: { auto: true, manual: true },
    apply: 'restart',
  },
}

/** The Runtime Control 2.x `model_gateway_schema` (the Server finds the key by the `modelGateway` component). */
function gatewaySchema(protocols: readonly string[]): JsonObject {
  return {
    type: 'object',
    title: 'Model gateway',
    required: ['baseUrl', 'apiKey'],
    properties: {
      baseUrl: { type: 'string', title: 'Gateway URL', minLength: 1, maxLength: 2048 },
      apiKey: { type: 'string', title: 'API key', minLength: 1, maxLength: 8192, writeOnly: true },
      ...(protocols.length > 1 ? { protocol: { type: 'string', enum: [...protocols] } } : {}),
    },
  }
}

/** One Runtime Control 2.x `RuntimeTypeDescriptor` (`server/agent_server/core/device_runtime.py`). */
export function runtimeTypeDescriptor(type: string, facts: ProviderFacts | null, error: string | null, provider?: RuntimeProvider): JsonObject {
  const available = facts !== null && facts.installed && facts.problems.length === 0
  const reason = available ? null : (facts?.problems[0]?.message ?? error ?? `${type} 没有安装`).slice(0, 1024) || `${type} 不可用`
  const full = provider?.instanceSchema?.() ?? null
  const baseSchema = (full?.schema ?? facts?.configSchema ?? null) as JsonObject | null
  const connection = MODEL_CONNECTIONS[type]
  let configSchema: JsonObject | null = null
  if (baseSchema !== null) {
    const properties = { ...((baseSchema.properties ?? {}) as JsonObject) }
    const fields = { ...(((full?.uiSchema as JsonObject | undefined)?.fields ?? {}) as JsonObject) }
    const order = [...((((full?.uiSchema as JsonObject | undefined)?.order ?? Object.keys(properties)) as string[]))]
    if (connection !== undefined) {
      properties[GATEWAY_FIELD] = gatewaySchema(connection.protocols as string[])
      fields[GATEWAY_FIELD] = { component: 'modelGateway' }
      if (!order.includes(GATEWAY_FIELD)) order.push(GATEWAY_FIELD)
    }
    configSchema = {
      revision: 1,
      schema: { ...baseSchema, properties },
      uiSchema: { order, fields },
      defaults: ((full?.defaults ?? {}) as JsonObject),
      metadata: {},
    }
  }
  const policy = facts?.instancePolicy ?? 'multiple'
  return {
    runtimeType: type,
    displayName: (facts?.displayName ?? type).slice(0, 128) || type,
    description: null,
    available,
    reason,
    recommended: false,
    recommendationRank: null,
    implementationType: null,
    configSchema,
    capabilities: {},
    metadata: {
      ...(facts !== null ? { processScope: facts.processScope } : {}),
      ...(facts?.agentVersion !== undefined ? { agentVersion: facts.agentVersion } : {}),
      ...(facts?.adapterVersion !== undefined ? { adapterVersion: facts.adapterVersion } : {}),
      ...(facts?.extraVersions !== undefined ? { extraVersions: facts.extraVersions as JsonObject } : {}),
    },
    instancePolicy: policy,
    maxInstances: policy === 'single' ? 1 : null,
    ...(connection !== undefined ? { modelConnection: connection } : {}),
  }
}

function modelConnectionReport(spec: RuntimeInstanceSpec, report: InstanceReport): ModelConnectionReport | null {
  const connection = MODEL_CONNECTIONS[spec.runtimeType]
  if (connection === undefined || report.status !== 'running') return null
  const protocol = spec.modelGateway?.protocol.replace('-', '_') ?? null
  return { state: spec.modelGateway !== undefined ? 'applied' : 'not_configured', protocol, scope: 'instance', mode: null, reason: null, externalOwner: null }
}

async function resultOf(registry: RuntimeRegistry, report: InstanceReport): Promise<RuntimeApplyResult> {
  const spec = registry.spec(report.runtimeId)
  const handle = report.status === 'running' ? await registry.started(report.runtimeId) : null
  const connection = spec !== null && report.stale !== true ? modelConnectionReport(spec, report) : null
  return {
    ...report,
    instanceId: registry.processId,
    ...(handle !== null && handle !== undefined ? { capabilities: capabilitySet(handle.capabilities(), { runtime: spec?.runtimeType ?? report.runtimeId, sessionId: null }) } : {}),
    ...(connection !== null ? { modelConnection: connection } : {}),
  }
}

/** `runtime.apply`: one instance's desired state, applied now, with what the device then has. */
export async function applyRuntime(registry: RuntimeRegistry, payload: unknown): Promise<RuntimeApplyResult> {
  return resultOf(registry, await registry.applyInstance(payload))
}

/** `channel.switch`: like `runtime.apply`, always restarting the instance, behind the Server's switch fence. */
export async function switchRuntimeChannel(registry: RuntimeRegistry, payload: unknown): Promise<RuntimeApplyResult> {
  return resultOf(registry, await registry.switchChannel(payload))
}

/** `device.settings.apply`: the whole settings object, handed to the host. */
export function applyDeviceSettings(payload: Record<string, unknown>, apply: (settings: Record<string, unknown>) => void): { applied: true } {
  const settings = payload.settings
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new RuntimeApplyError('invalid_argument', 'settings must be an object')
  apply(settings as Record<string, unknown>)
  return { applied: true }
}

/**
 * `LinkWelcome.desired`: the whole instance list (instances not in it are removed), then pending channel switches.
 * Each item is read by `runtimeSpecFrom`, so the Server's fields (`active`, `config`) decide.
 */
export async function applyDesiredRuntimes(registry: RuntimeRegistry, desired: { readonly runtimes?: readonly unknown[]; readonly channelSwitches?: readonly unknown[] } | undefined, log: Log): Promise<void> {
  registry.apply(desired?.runtimes ?? [])
  for (const item of desired?.channelSwitches ?? []) {
    try {
      await registry.switchChannel(item)
    } catch (error) {
      log('warn', `channel switch ${String(runtimeSpecFrom(item)?.runtimeId ?? '?')} not applied: ${(error as Error)?.message ?? String(error)}`)
    }
  }
}

/**
 * What the device has, as `runtime.status` (lossy; sent again whenever the link comes online): the type descriptors,
 * then every instance with its installation facts and applied state. `onInstalled` is told about each enabled,
 * usable instance (the host scans its native sessions).
 */
export async function announceRuntimes(registry: RuntimeRegistry, live: LiveEvents, log: Log, onInstalled?: (spec: RuntimeInstanceSpec) => void): Promise<void> {
  try {
    const discovered = await registry.discover()
    const byType = new Map<string, { facts: ProviderFacts | null; error: string | null }>()
    for (const { spec, facts, error } of discovered) if (!byType.has(spec.runtimeType)) byType.set(spec.runtimeType, { facts, error })
    live.emit('runtime.status', {
      runtimeId: '*',
      status: {
        event: 'runtime.types',
        // Runtime Control 2.1 descriptors, built as JSON by `runtimeTypeDescriptor`.
        runtimeTypes: [...byType].map(([type, { facts, error }]) => runtimeTypeDescriptor(type, facts, error, registry.provider(type))) as unknown as NonNullable<ContractStatusOf<'runtime.types'>['runtimeTypes']>,
        features: [...RUNTIME_CONTROL_FEATURES],
      },
    })
    for (const { spec, facts, error } of discovered) {
      const usable = spec.enabled && facts?.installed === true && facts.problems.length === 0
      const report: InstanceReport = usable
        ? await registry.report(spec)
        : spec.enabled
          ? { runtimeId: spec.runtimeId, status: 'error', error: facts?.problems[0] ?? { code: 'runtime_discovery_failed', message: error ?? `${spec.runtimeType} is not installed` } }
          : { runtimeId: spec.runtimeId, status: 'stopped' }
      const result = await resultOf(registry, report)
      live.emit('runtime.status', {
        runtimeId: spec.runtimeId,
        status: {
          runtimeType: spec.runtimeType,
          enabled: spec.enabled,
          installed: facts?.installed ?? false,
          ...(facts !== null ? { displayName: facts.displayName, instancePolicy: facts.instancePolicy, processScope: facts.processScope, problems: facts.problems } : {}),
          ...(facts?.agentVersion !== undefined ? { agentVersion: facts.agentVersion } : {}),
          ...(facts?.adapterVersion !== undefined ? { adapterVersion: facts.adapterVersion } : {}),
          ...(facts?.extraVersions !== undefined ? { extraVersions: facts.extraVersions } : {}),
          ...(facts?.configSchema !== undefined ? { configSchema: facts.configSchema } : {}),
          ...(error !== null ? { error: { code: 'runtime_discovery_failed', message: error } } : {}),
          instance: {
            status: result.status,
            ...(result.error !== undefined ? { error: result.error } : {}),
            ...(result.modelConnection !== undefined ? { modelConnection: result.modelConnection } : {}),
          },
        },
        ...(result.capabilities !== undefined ? { capabilities: result.capabilities } : {}),
      })
      if (usable && report.status === 'running') onInstalled?.(spec)
    }
  } catch (error) {
    log('warn', `runtime discovery failed: ${(error as Error)?.message ?? String(error)}`)
  }
}
