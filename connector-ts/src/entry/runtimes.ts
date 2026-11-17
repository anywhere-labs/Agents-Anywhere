import { randomBytes } from 'node:crypto'

import type { RuntimeHandles } from '../application/ports/index.js'
import type {
  JsonObject,
  ModelGatewayConfig,
  NativeSessionSummary,
  ProviderFacts,
  RuntimeHandle,
  RuntimeHandleEvent,
  RuntimeProvider,
} from '../application/ports/runtime-session.js'
import {
  acpNativeInventorySessionId,
  claudeStableSessionId,
  codexStableSessionId,
  piNativeSessionId,
  sessionNamespace,
  type SourceKey,
} from '../domain/identity/index.js'
import { claudeProvider } from '../runtime/profiles/claude/index.js'
import { codexProvider } from '../runtime/profiles/codex/index.js'
import { officialAcpProviders } from '../runtime/profiles/generic/index.js'
import { hermesProvider } from '../runtime/profiles/hermes/index.js'
import { piProvider } from '../runtime/profiles/pi/provider.js'
import type { Log } from './compose.js'

/**
 * One Runtime instance on this device (v2 `RuntimeInstanceSpec`). The legacy instance of a type has
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
 * only when there is more than one, as v2's `model_gateway_schema`).
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

export interface BuiltinProviderOptions {
  readonly log: Log
}

/** The Runtime profiles this build ships (B's `runtime/profiles`); DSH comes from E's routes. */
export function builtinProviders(options: BuiltinProviderOptions): RuntimeProvider[] {
  const onStderr = (instanceId: string, line: string): void => options.log('debug', `[${instanceId}] ${line}`)
  return [
    codexProvider({ onStderr }),
    claudeProvider({ onStderr }),
    // Pi keeps v2's instance directory and caches (`~/.agents-anywhere/connector/pi`) so an upgrade reuses them.
    piProvider({ onStderr }),
    hermesProvider({ onStderr }),
    ...officialAcpProviders({ onStderr }),
  ]
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

/** Providers that check instance settings before starting (ACP profiles, Pi). */
interface ValidatingProvider extends RuntimeProvider {
  validateSettings(settings: JsonObject, modelGateway?: ModelGatewayConfig): unknown
}

function validating(provider: RuntimeProvider): provider is ValidatingProvider {
  return typeof (provider as Partial<ValidatingProvider>).validateSettings === 'function'
}

function failureOf(error: unknown): { code: string; message: string } {
  const runtimeError = (error as { error?: { code?: unknown; message?: unknown } })?.error
  if (typeof runtimeError?.code === 'string') return { code: runtimeError.code, message: String(runtimeError.message ?? runtimeError.code) }
  const code = (error as { code?: unknown })?.code
  return { code: typeof code === 'string' ? code : 'runtime_start_failed', message: (error as Error)?.message ?? String(error) }
}

export interface RuntimeRegistryOptions {
  readonly connectorId: string
  readonly providers: readonly RuntimeProvider[]
  readonly log: Log
  /** Runtime-level events of a started instance (status, native session changes, follow suggestions). */
  readonly onEvent?: (spec: RuntimeInstanceSpec, handle: RuntimeHandle, event: RuntimeHandleEvent) => void
  /** This process's identity in `runtime.apply` results (tests fix it); default random. */
  readonly processId?: string
}

interface Running {
  readonly spec: RuntimeInstanceSpec
  readonly handle: Promise<RuntimeHandle | null>
}

/** The same instance to run: revisions and names do not restart anything. */
function sameSpec(left: RuntimeInstanceSpec, right: RuntimeInstanceSpec): boolean {
  const essence = ({ revision: _revision, name: _name, ...rest }: RuntimeInstanceSpec): RuntimeInstanceSpec => rest
  return JSON.stringify(essence(left)) === JSON.stringify(essence(right))
}

/**
 * The Runtime instances of this device and their handles (the session engine's `RuntimeHandles`): the legacy
 * instance of every shipped type, plus named instances from the Server's desired state. An instance starts on
 * first use; a changed or removed instance is stopped, and the next use starts it with the new settings.
 */
export class RuntimeRegistry implements RuntimeHandles {
  /** This process's identity: the Server tells a restarted device from one that kept running. */
  public readonly processId: string
  private readonly providers = new Map<string, RuntimeProvider>()
  private specs = new Map<string, RuntimeInstanceSpec>()
  private readonly running = new Map<string, Running>()
  private readonly startErrors = new Map<string, { code: string; message: string }>()
  private readonly switchRevisions = new Map<string, number>()
  private closed = false

  public constructor(private readonly options: RuntimeRegistryOptions) {
    this.processId = options.processId ?? `dp_${randomBytes(9).toString('base64url')}`
    for (const provider of options.providers) this.providers.set(provider.type, provider)
    for (const type of this.providers.keys()) this.specs.set(type, { runtimeId: type, runtimeType: type, settings: {}, sourceKey: null, enabled: true })
  }

  public instances(): RuntimeInstanceSpec[] {
    return [...this.specs.values()]
  }

  public spec(runtimeId: string): RuntimeInstanceSpec | null {
    return this.specs.get(runtimeId) ?? null
  }

  public provider(runtimeType: string): RuntimeProvider | undefined {
    return this.providers.get(runtimeType)
  }

  /**
   * Applies the Server's desired instances: listed ones replace the local spec (a legacy instance may be
   * disabled or given settings), named ones not listed any more are removed. Unknown types are logged and skipped.
   */
  public apply(desired: readonly unknown[]): void {
    const next = new Map<string, RuntimeInstanceSpec>()
    for (const type of this.providers.keys()) next.set(type, { runtimeId: type, runtimeType: type, settings: {}, sourceKey: null, enabled: true })
    for (const item of desired) {
      const spec = runtimeSpecFrom(item)
      if (spec === null) {
        this.options.log('warn', 'ignoring a desired runtime without runtimeId and runtimeType')
        continue
      }
      if (!this.providers.has(spec.runtimeType)) {
        this.options.log('warn', `ignoring desired runtime ${spec.runtimeId}: type ${spec.runtimeType} is not in this build`)
        continue
      }
      next.set(spec.runtimeId, spec)
    }
    for (const [runtimeId, running] of this.running) {
      const spec = next.get(runtimeId)
      if (spec === undefined || !sameSpec(spec, running.spec)) void this.stopOne(runtimeId)
    }
    this.specs = next
  }

  /**
   * `runtime.apply`: one instance's desired state, applied now. Rejects (coded) what cannot run: an unknown
   * type, settings or a gateway the provider refuses. A lower `revision` than the applied one is stale and changes
   * nothing. An enabled instance is started so its status is known; a changed running one is replaced first.
   */
  public async applyInstance(item: unknown, options: { readonly restart?: boolean } = {}): Promise<InstanceReport> {
    const spec = runtimeSpecFrom(item)
    if (spec === null) throw new RuntimeApplyError('invalid_argument', 'runtimeId and runtimeType are required')
    const provider = this.providers.get(spec.runtimeType)
    if (provider === undefined) throw new RuntimeApplyError('runtime_type_unknown', `${spec.runtimeType} is not in this build`)
    const current = this.specs.get(spec.runtimeId)
    if (current?.revision !== undefined && spec.revision !== undefined && spec.revision < current.revision) {
      return { ...(await this.report(current)), stale: true }
    }
    if (spec.enabled && validating(provider)) {
      try {
        provider.validateSettings(spec.settings, spec.modelGateway)
      } catch (error) {
        const failure = failureOf(error)
        throw new RuntimeApplyError(failure.code === 'runtime_start_failed' ? 'invalid_config' : failure.code, failure.message)
      }
    }
    this.specs.set(spec.runtimeId, spec)
    const running = this.running.get(spec.runtimeId)
    if (running !== undefined && (options.restart === true || !sameSpec(spec, running.spec))) await this.stopOne(spec.runtimeId)
    return this.report(spec)
  }

  /** `channel.switch`: like `applyInstance`, always restarting, and only for a newer `switchRevision`. */
  public async switchChannel(item: unknown): Promise<InstanceReport> {
    const record = object(item) ?? {}
    const runtimeId = text(record.runtimeId)
    const revision = typeof record.switchRevision === 'number' ? record.switchRevision : null
    if (runtimeId !== null && revision !== null) {
      const applied = this.switchRevisions.get(runtimeId)
      if (applied !== undefined && revision < applied) throw new RuntimeApplyError('switch_revision_stale', `switch revision ${revision} is older than ${applied}`)
    }
    const report = await this.applyInstance(item, { restart: true })
    if (runtimeId !== null && revision !== null) this.switchRevisions.set(runtimeId, revision)
    return report
  }

  /** An instance's state now; starts an enabled one that is not running yet. */
  public async report(spec: RuntimeInstanceSpec): Promise<InstanceReport> {
    const revision = spec.revision !== undefined ? { revision: spec.revision } : {}
    if (!spec.enabled) return { runtimeId: spec.runtimeId, status: 'stopped', ...revision }
    const handle = await this.handle(spec.runtimeId)
    if (handle !== null) return { runtimeId: spec.runtimeId, status: 'running', ...revision }
    const error = this.startErrors.get(spec.runtimeId) ?? { code: 'runtime_start_failed', message: `${spec.runtimeId} did not start` }
    return { runtimeId: spec.runtimeId, status: 'error', error, ...revision }
  }

  public async handle(runtimeId: string): Promise<RuntimeHandle | null> {
    if (this.closed) return null
    const spec = this.specs.get(runtimeId)
    if (spec === undefined || !spec.enabled) return null
    const existing = this.running.get(runtimeId)
    if (existing !== undefined) return existing.handle
    const provider = this.providers.get(spec.runtimeType)!
    const handle = provider
      .start({
        instanceId: spec.runtimeId,
        sessionNamespace: sessionNamespace({ connectorId: this.options.connectorId, runtimeType: spec.runtimeType, runtimeId: spec.runtimeId, sourceKey: spec.sourceKey }),
        settings: spec.settings,
        ...(spec.modelGateway !== undefined ? { modelGateway: spec.modelGateway } : {}),
      })
      .then(started => {
        this.startErrors.delete(runtimeId)
        this.pump(spec, started)
        return started
      })
      .catch((error: unknown) => {
        // Not cached: the next use tries again (the user may install or fix the Agent meanwhile).
        if (this.running.get(runtimeId)?.handle === handle) this.running.delete(runtimeId)
        this.startErrors.set(runtimeId, failureOf(error))
        this.options.log('warn', `runtime ${runtimeId} did not start: ${(error as Error)?.message ?? String(error)}`)
        return null
      })
    this.running.set(runtimeId, { spec, handle })
    return handle
  }

  /** Whether the instance has a started handle (runtime-level facts come from it). */
  public started(runtimeId: string): Promise<RuntimeHandle | null> | null {
    return this.running.get(runtimeId)?.handle ?? null
  }

  /** Installation facts of every instance's type; never starts an Agent. */
  public async discover(): Promise<{ spec: RuntimeInstanceSpec; facts: ProviderFacts | null; error: string | null }[]> {
    const byType = new Map<string, Promise<ProviderFacts>>()
    return Promise.all(this.instances().map(async spec => {
      let facts = byType.get(spec.runtimeType)
      if (facts === undefined) {
        facts = this.providers.get(spec.runtimeType)!.discover()
        byType.set(spec.runtimeType, facts)
      }
      try {
        return { spec, facts: await facts, error: null }
      } catch (error) {
        return { spec, facts: null, error: (error as Error)?.message ?? String(error) }
      }
    }))
  }

  public async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.running.keys()].map(runtimeId => this.stopOne(runtimeId)))
  }

  private stopOne(runtimeId: string): Promise<void> {
    const running = this.running.get(runtimeId)
    if (running === undefined) return Promise.resolve()
    this.running.delete(runtimeId)
    return running.handle.then(handle => handle?.stop()).catch(error => {
      this.options.log('warn', `runtime ${runtimeId} did not stop cleanly: ${(error as Error)?.message ?? String(error)}`)
    })
  }

  private pump(spec: RuntimeInstanceSpec, handle: RuntimeHandle): void {
    const onEvent = this.options.onEvent
    void (async () => {
      try {
        for await (const event of handle.events) onEvent?.(spec, handle, event)
      } catch (error) {
        this.options.log('warn', `runtime ${spec.runtimeId} events ended: ${(error as Error)?.message ?? String(error)}`)
      }
    })()
  }
}
