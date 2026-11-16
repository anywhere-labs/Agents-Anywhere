import { MeshCallError, ResourceExhaustedError, method, service, z, type DuplexChannel, type RpcContext } from 'meshcall'

import { CommandInbox, errorCode } from '../application/inbound/index.js'
import type { OutboxStore } from '../application/ports/index.js'
import type { CommandCall } from '../generated/device-meshcall/v1_0/command-call.js'
import { chunkJson, outboxStream, watchSession, type DeviceReaders, type OutboxStreamOptions, type WatchDeps } from '../sync/index.js'
import type { AttachHub } from './attach.js'

export const CONNECTION_METADATA = 'aa-connection-id'

export type E2eeMode = 'off' | 'required'

/** Service → methods the device registers, per E2EE mode. */
export type Registration = Readonly<Record<string, readonly string[]>>

const COMMAND_METHODS = [
  'sessionSendMessage', 'sessionSteer', 'sessionInterrupt', 'sessionRespondNotice', 'sessionSelect', 'sessionCreationBegin',
  'sessionPlanning', 'sessionGoal', 'sessionQueueUpdate', 'sessionQueueDelete', 'sessionQueueRetry', 'sessionQueueSendNow',
  'sessionQueueResume', 'sessionQueueReorder', 'sessionQueueClear', 'sessionSync', 'runtimeApply', 'deviceSettingsApply',
  'channelSwitch', 'previewOpen', 'previewClose',
] as const

/**
 * What the device registers, per mode: the same table as `contracts/device-meshcall/1.0/e2ee-registration.json`
 * (F's encrypted-mode contract). In encrypted mode only Link, Secure and the Server-initiated, content-free
 * commands are on the Router, so the Server has nothing to send a plaintext read or user command to.
 */
export const DEFAULT_REGISTRATION: Readonly<Record<E2eeMode, Registration>> = {
  off: {
    'aa.device.v1.Link': ['attach', 'outbox', 'ackOutbox'],
    'aa.device.v1.Sessions': ['snapshot', 'watch', 'notices', 'state', 'capabilities', 'queue'],
    'aa.device.v1.Store': ['read', 'changesSince', 'readBlob', 'exportShare', 'planDocument'],
    'aa.device.v1.Runtime': ['catalogs'],
    'aa.device.v1.Commands': ['status', ...COMMAND_METHODS],
  },
  required: {
    'aa.device.v1.Link': ['attach', 'outbox', 'ackOutbox'],
    'aa.device.v1.Commands': ['status', 'runtimeApply', 'deviceSettingsApply', 'channelSwitch', 'previewOpen', 'previewClose'],
    'aa.device.v1.Secure': ['channel'],
  },
}

/** Concurrency classes: long streams cannot starve approvals, notices or the outbox acknowledgements. */
export type CallClass = 'critical' | 'command' | 'read' | 'stream' | 'secure'

export const DEFAULT_LIMITS: Readonly<Record<CallClass, number>> = {
  critical: 64,
  command: 64,
  read: 64,
  stream: 512,
  secure: 256,
}

/**
 * The Server's `CRITICAL_METHODS` (v2 #484's critical channel: approvals, notices, session creation and workspace
 * preparation prompts), plus the link's own streams and receipt lookups.
 */
const CRITICAL = new Set([
  'attach', 'outbox', 'ackOutbox', 'status', 'sessionInterrupt',
  'sessionRespondNotice', 'notices', 'creationGet', 'sessionCreationRespond', 'sessionCreationCancel',
  'workspacePreparationGet', 'workspacePreparationRespond', 'workspacePreparationCancel',
])

export function callClass(serviceName: string, methodName: string): CallClass {
  if (CRITICAL.has(methodName)) return 'critical'
  if (serviceName === 'aa.device.v1.Secure') return 'secure'
  if (serviceName === 'aa.device.v1.Commands') return 'command'
  if (['watch', 'snapshot', 'readBlob', 'exportShare'].includes(methodName)) return 'stream'
  return 'read'
}

/** Secure/channel handler (F's `channel/`): runs one client's encrypted channel. */
export type SecureChannelHandler = (request: Record<string, unknown>, channel: DuplexChannel<Record<string, unknown>, Record<string, unknown>>, context: RpcContext) => Promise<void>

export interface DeviceServicesDeps {
  /** The current connection generation; calls carrying another are refused. */
  readonly connectionId: () => string | null
  readonly attach: AttachHub
  readonly outbox: OutboxStreamOptions & { readonly store?: OutboxStore }
  readonly watch: WatchDeps
  readonly readers: DeviceReaders
  readonly inbox: CommandInbox
  readonly secure?: SecureChannelHandler
  /** Largest `StreamChunk.chunk` in UTF-8 bytes; keep well under the 4 MiB frame (JSON escaping can double it). */
  readonly chunkBytes?: number
  readonly limits?: Partial<Record<CallClass, number>>
  /** A command settled (its `command.result` is in the outbox). */
  readonly onCommand?: () => void
}

const looseObject = z.looseObject({})
const anyItem = z.looseObject({})

/** Thrown when a call carries another generation's `aa-connection-id` (the Server then says hello again). */
export function connectionReplaced(): MeshCallError {
  return new MeshCallError('failed_precondition', 'this call belongs to a replaced connection', { details: { reason: 'connection_replaced' } })
}

/** AA error codes travel as MeshCall application errors; anything uncoded stays `internal`. */
function asMeshError(error: unknown): unknown {
  if (error instanceof MeshCallError) return error
  const coded = errorCode(error)
  if (coded.code === 'internal') return error
  return new MeshCallError(coded.code, coded.message, coded.retryable === true ? { retryable: true } : {})
}

interface MethodDef {
  readonly name: string
  readonly kind: 'unary' | 'server_stream' | 'duplex'
  readonly description: string
  readonly request?: z.ZodType
  readonly idempotent?: boolean
  readonly readOnly?: boolean
  readonly handler: (...args: never[]) => unknown
}

/**
 * Builds a `@service` instance without decorator syntax: the decorators are plain functions of `(fn, context)`,
 * and the Commands service has one method per registered command, which a class literal cannot list per mode.
 */
export function defineService(name: string, description: string, methods: readonly MethodDef[]): object {
  const Service = class {}
  Object.defineProperty(Service, 'name', { value: name.split('.').pop() ?? 'Service' })
  const prototype = Service.prototype as Record<string, unknown>
  for (const def of methods) {
    const fn = def.handler
    prototype[def.name] = fn
    const context = { kind: 'method', name: def.name, static: false, private: false, metadata: {}, access: { has: () => true, get: () => fn }, addInitializer: () => undefined } as unknown as ClassMethodDecoratorContext
    const request = def.request ?? looseObject
    const semantics = { description: def.description, ...(def.idempotent !== undefined ? { idempotent: def.idempotent } : {}), ...(def.readOnly !== undefined ? { readOnly: def.readOnly } : {}) }
    if (def.kind === 'unary') method({ ...semantics, request, response: looseObject })(fn as never, context)
    else if (def.kind === 'server_stream') method.serverStream({ ...semantics, request, outputItem: anyItem })(fn as never, context)
    else method.duplex({ description: def.description, reason: 'one encrypted client channel: frames flow both ways for its whole life', request, inputItem: anyItem, outputItem: anyItem })(fn as never, context)
  }
  service(name, { description, targeted: true })(Service, { kind: 'class', name: Service.name, metadata: {}, addInitializer: () => undefined } as unknown as ClassDecoratorContext)
  return new Service()
}

class Limiter {
  private readonly inflight = new Map<CallClass, number>()

  public constructor(private readonly limits: Readonly<Record<CallClass, number>>) {}

  public enter(kind: CallClass): () => void {
    const count = this.inflight.get(kind) ?? 0
    if (count >= this.limits[kind]) {
      throw new ResourceExhaustedError(`too many ${kind} calls in flight`, { retryable: true, details: { reason: 'overloaded', class: kind } })
    }
    this.inflight.set(kind, count + 1)
    let left = false
    return () => {
      if (left) return
      left = true
      this.inflight.set(kind, (this.inflight.get(kind) ?? 1) - 1)
    }
  }

  public count(kind: CallClass): number {
    return this.inflight.get(kind) ?? 0
  }
}

/**
 * `aa.device.v1.*` (06-protocols.md §2.3), mounted as targeted services under `instance_id = deviceId`. Every call
 * checks `aa-connection-id` against the current generation first; then its concurrency class. Commands run to
 * completion even when the caller gave up (the receipt settles and `command.result` reports it).
 */
export class DeviceServices {
  private readonly limiter: Limiter
  private outboxController: AbortController | null = null

  public constructor(private readonly deps: DeviceServicesDeps) {
    this.limiter = new Limiter({ ...DEFAULT_LIMITS, ...deps.limits })
  }

  public inflight(kind: CallClass): number {
    return this.limiter.count(kind)
  }

  /** Ends the open outbox stream (a stalled holder, a replaced generation). */
  public endOutbox(): void {
    this.outboxController?.abort()
    this.outboxController = null
  }

  private gate(context: RpcContext, claimed?: unknown): void {
    const current = this.deps.connectionId()
    const presented = context.metadata[CONNECTION_METADATA] ?? (typeof claimed === 'string' ? claimed : undefined)
    if (current === null || presented !== current) throw connectionReplaced()
    if (typeof claimed === 'string' && claimed !== current) throw connectionReplaced()
  }

  private unary(serviceName: string, name: string, description: string, run: (request: Record<string, unknown>, context: RpcContext) => Promise<unknown>, extra: Partial<MethodDef> = {}): MethodDef {
    return {
      name,
      kind: 'unary',
      description,
      readOnly: true,
      ...extra,
      handler: (async (request: Record<string, unknown>, context: RpcContext) => {
        this.gate(context)
        const leave = this.limiter.enter(callClass(serviceName, name))
        try {
          return await run(request, context)
        } catch (error) {
          throw asMeshError(error)
        } finally {
          leave()
        }
      }) as never,
    }
  }

  private stream(serviceName: string, name: string, description: string, run: (request: Record<string, unknown>, context: RpcContext) => AsyncIterable<unknown>, extra: Partial<MethodDef> = {}): MethodDef {
    const self = this
    return {
      name,
      kind: 'server_stream',
      description,
      readOnly: true,
      ...extra,
      handler: (async function* (request: Record<string, unknown>, context: RpcContext) {
        self.gate(context, name === 'attach' || name === 'outbox' ? request.connectionId : undefined)
        const leave = self.limiter.enter(callClass(serviceName, name))
        try {
          yield* run(request, context)
        } catch (error) {
          throw asMeshError(error)
        } finally {
          leave()
        }
      }) as never,
    }
  }

  private linkMethods(): MethodDef[] {
    const S = 'aa.device.v1.Link'
    return [
      this.stream(S, 'attach', 'Heartbeat every 20 s and lossy current-state events; the open stream is the device presence.',
        (request, context) => this.deps.attach.open(String(request.connectionId), context.signal),
        { request: z.looseObject({ connectionId: z.string().min(1) }) }),
      this.stream(S, 'outbox', 'Must-deliver messages from the lowest unacknowledged oid, in oid order.', (_request, context) => {
        // At most one outbox stream per generation: a new one ends the previous.
        this.outboxController?.abort()
        const controller = new AbortController()
        this.outboxController = controller
        return outboxStream(this.deps.outbox, AbortSignal.any([controller.signal, context.signal]))
      }, { request: z.looseObject({ connectionId: z.string().min(1) }) }),
      this.unary(S, 'ackOutbox', 'Cumulative acknowledgement: every record up to oid may be deleted.', async request => {
        const oid = Number(request.oid)
        if (!Number.isSafeInteger(oid) || oid < 0) throw new MeshCallError('invalid_argument', 'oid must be a non-negative integer')
        const store = this.deps.outbox.store ?? this.deps.outbox.outbox
        await store.ack(oid)
        return {}
      }, { readOnly: false, idempotent: true, request: z.looseObject({ oid: z.number().int().min(0) }) }),
    ]
  }

  private sessionsMethods(): MethodDef[] {
    const S = 'aa.device.v1.Sessions'
    const readers = this.deps.readers
    const chunkBytes = this.deps.chunkBytes ?? 512 * 1024
    const sessionId = (request: Record<string, unknown>): string => {
      if (typeof request.sessionId !== 'string' || request.sessionId === '') throw new MeshCallError('invalid_argument', 'sessionId is required')
      return request.sessionId
    }
    return [
      this.stream(S, 'snapshot', 'Client-shaped snapshot body, in StreamChunk pieces under the frame limit.', async function* (request) {
        const body = await readers.snapshot({
          sessionId: sessionId(request),
          ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
          ...(typeof request.byteBudget === 'number' ? { byteBudget: request.byteBudget } : {}),
        })
        yield* chunkJson(body, chunkBytes)
      }),
      this.stream(S, 'watch', 'Opening subscribes and cancelling unsubscribes; items are ChangesEvent.', (request, context) => {
        const afterSeq = Number(request.afterSeq ?? 0)
        return watchSession(this.deps.watch, { sessionId: sessionId(request), afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0 }, context.signal)
      }),
      this.unary(S, 'notices', 'The current notices of a session.', async request => readers.notices({ sessionId: sessionId(request) })),
      this.unary(S, 'state', 'Runtime state of a session.', async request => readers.sessionState({ sessionId: sessionId(request) })),
      this.unary(S, 'capabilities', 'Effective capabilities of a session.', async request => readers.capabilities({ sessionId: sessionId(request) })),
      this.unary(S, 'queue', 'Queued messages of a session.', async request => readers.queue({ sessionId: sessionId(request) })),
    ]
  }

  private storeMethods(): MethodDef[] {
    const S = 'aa.device.v1.Store'
    const readers = this.deps.readers
    const unimplemented = (name: string) => this.stream(S, name, 'Large reads go through the HTTP relay (not available on this device yet).', async function* () {
      yield* []
      throw new MeshCallError('unimplemented', `${name} is not available on this device yet`)
    })
    return [
      this.unary(S, 'read', 'Paged history by orderSeq, bounded by count and bytes.', async request => readers.read(request as never)),
      this.unary(S, 'changesSince', 'Changes after a clock position, or snapshotRequired.', async request => readers.changesSince(request as never)),
      this.unary(S, 'planDocument', 'An immutable plan revision.', async request => readers.planDocument(request as never)),
      unimplemented('readBlob'),
      unimplemented('exportShare'),
    ]
  }

  private runtimeMethods(): MethodDef[] {
    return [this.unary('aa.device.v1.Runtime', 'catalogs', 'Model, mode and command catalogs of a session.', async request => this.deps.readers.catalogs(request as never))]
  }

  private commandMethods(names: readonly string[]): MethodDef[] {
    const S = 'aa.device.v1.Commands'
    const callSchema = z.looseObject({ commandId: z.string().min(1), deadline: z.string(), inputDigest: z.string().nullable().optional(), p: z.looseObject({}).optional() })
    return names.map(name => {
      if (name === 'status') {
        return this.unary(S, 'status', 'Receipt lookup by commandId; never executes anything.', async request => this.deps.readers.commandStatus({ commandId: String(request.commandId) }),
          { request: z.looseObject({ commandId: z.string().min(1) }) })
      }
      return this.unary(S, name, `Command ${name}: accepted only once its effect and receipt are on disk.`, async request => {
        // Not tied to the call's signal: a command the caller stopped waiting for still settles.
        const ack = await this.deps.inbox.handle(name, request as unknown as CommandCall)
        this.deps.onCommand?.()
        return ack
      }, { readOnly: false, idempotent: true, request: callSchema })
    })
  }

  private secureMethods(): MethodDef[] {
    const handler = this.deps.secure
    if (handler === undefined) return []
    return [{
      name: 'channel',
      kind: 'duplex',
      description: 'One encrypted client channel; the Server forwards the frames untouched.',
      request: z.looseObject({ clientId: z.string().min(1), ch: z.string().min(1) }),
      handler: (async (request: Record<string, unknown>, channel: DuplexChannel<Record<string, unknown>, Record<string, unknown>>, context: RpcContext) => {
        this.gate(context)
        const leave = this.limiter.enter('secure')
        try {
          await handler(request, channel, context)
        } finally {
          leave()
        }
      }) as never,
    }]
  }

  /**
   * The services of `registration`, limited to those the Router token grants (`granted` null = all): the
   * Router refuses a whole registration that names a service the token does not cover.
   */
  public build(registration: Registration, granted: readonly string[] | null): { services: object[]; names: string[]; skipped: string[] } {
    const all: Record<string, () => MethodDef[]> = {
      'aa.device.v1.Link': () => this.linkMethods(),
      'aa.device.v1.Sessions': () => this.sessionsMethods(),
      'aa.device.v1.Store': () => this.storeMethods(),
      'aa.device.v1.Runtime': () => this.runtimeMethods(),
      'aa.device.v1.Commands': () => this.commandMethods(registration['aa.device.v1.Commands'] ?? []),
      'aa.device.v1.Secure': () => this.secureMethods(),
    }
    const services: object[] = []
    const names: string[] = []
    const skipped: string[] = []
    for (const [name, wanted] of Object.entries(registration)) {
      const factory = all[name]
      if (factory === undefined || wanted.length === 0) continue
      if (granted !== null && !granted.includes(name)) {
        skipped.push(name)
        continue
      }
      const methods = factory().filter(def => wanted.includes(def.name))
      if (methods.length === 0) {
        skipped.push(name)
        continue
      }
      services.push(defineService(name, `Agents Anywhere device ${name.split('.').pop()}`, methods))
      names.push(name)
    }
    return { services, names, skipped }
  }
}
