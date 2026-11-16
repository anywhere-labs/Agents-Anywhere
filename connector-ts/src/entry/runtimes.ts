
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

/**
 * One entry of `LinkWelcome.desired.runtimes`. The contract leaves the item open; this reads
 * `{runtimeId, runtimeType, settings | values, enabled?, sourceKey?: {kind, key}, modelGateway?}` and drops
 * anything else, so an unknown entry never reaches a provider.
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
  const gateway = object(record.modelGateway)
  const baseUrl = text(gateway?.baseUrl)
  const authToken = text(gateway?.authToken)
  const protocol = text(gateway?.protocol)
  return {
    runtimeId,
    runtimeType,
    settings: object(record.settings) ?? object(record.values) ?? {},
    sourceKey: kind !== null && key !== null ? { kind, key } : null,
    enabled: record.enabled !== false,
    ...(baseUrl !== null && authToken !== null && (protocol === 'anthropic' || protocol === 'openai-responses' || protocol === 'openai-chat')
      ? { modelGateway: { baseUrl, authToken, protocol, ...(text(gateway?.model) !== null ? { model: text(gateway?.model)! } : {}) } }
      : {}),
  }
}

export interface RuntimeRegistryOptions {
  readonly connectorId: string
  readonly providers: readonly RuntimeProvider[]
  readonly log: Log
  /** Runtime-level events of a started instance (status, native session changes, follow suggestions). */
  readonly onEvent?: (spec: RuntimeInstanceSpec, handle: RuntimeHandle, event: RuntimeHandleEvent) => void
}

interface Running {
  readonly spec: RuntimeInstanceSpec
  readonly handle: Promise<RuntimeHandle | null>
}

function sameSpec(left: RuntimeInstanceSpec, right: RuntimeInstanceSpec): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The Runtime instances of this device and their handles (the session engine's `RuntimeHandles`): the legacy
 * instance of every shipped type, plus named instances from the Server's desired state. An instance starts on
 * first use; a changed or removed instance is stopped, and the next use starts it with the new settings.
 */
export class RuntimeRegistry implements RuntimeHandles {
  private readonly providers = new Map<string, RuntimeProvider>()
  private specs = new Map<string, RuntimeInstanceSpec>()
  private readonly running = new Map<string, Running>()
  private closed = false

  public constructor(private readonly options: RuntimeRegistryOptions) {
    for (const provider of options.providers) this.providers.set(provider.type, provider)
    for (const type of this.providers.keys()) this.specs.set(type, { runtimeId: type, runtimeType: type, settings: {}, sourceKey: null, enabled: true })
  }

  public instances(): RuntimeInstanceSpec[] {
    return [...this.specs.values()]
  }

  public spec(runtimeId: string): RuntimeInstanceSpec | null {
    return this.specs.get(runtimeId) ?? null
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
      if (spec === undefined || !sameSpec(spec, running.spec)) this.stopOne(runtimeId)
    }
    this.specs = next
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
        this.pump(spec, started)
        return started
      })
      .catch((error: unknown) => {
        // Not cached: the next use tries again (the user may install or fix the Agent meanwhile).
        if (this.running.get(runtimeId)?.handle === handle) this.running.delete(runtimeId)
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
