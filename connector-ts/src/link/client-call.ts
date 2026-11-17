// aa.device.v1.Client (normal mode, contracts/device-meshcall/1.0 Client section): the Server forwards a client
// API request it does not answer itself, and the device answers it with the same tunnel API the secure channel
// uses. `call` streams a head (status, command outcome) and the JSON body in chunks; `subscribe` streams a terminal.
import { MeshCallError, z } from 'meshcall'

import type { ChannelCaller, TunnelApi, TunnelApiRequest, TunnelCallContext } from '../application/inbound/tunnel-api.js'
import type { ClientCallChunk, ClientCallHead, ClientCommandOutcome } from '../generated/device-meshcall/v1_0/client-call-item.js'
import type { ClientCallRequest, ClientCommand } from '../generated/device-meshcall/v1_0/client-call-request.js'
import { CLIENT_LIMITS, CLIENT_ROUTES, GENERATED_COMMAND_ID, type ClientRouteEntry } from '../generated/device-meshcall/v1_0/client-routes.js'
import type { ClientSubscribeRequest } from '../generated/device-meshcall/v1_0/client-subscribe-request.js'
import type { TerminalStreamItem } from '../generated/device-meshcall/v1_0/terminal-stream-item.js'
import { chunkText } from '../sync/index.js'
import type { TerminalOutputItem, TerminalSource, TerminalWatchers } from './workspace.js'

export const CLIENT_SERVICE = 'aa.device.v1.Client'

export interface ClientLimits {
  /** Largest `ClientCallChunk.chunk`, in UTF-8 bytes. */
  readonly maxChunkBytes: number
  /** Largest request body, in UTF-8 bytes of its JSON. */
  readonly maxRequestBodyBytes: number
  /** Largest response body, in UTF-8 bytes of its JSON. */
  readonly maxResponseBytes: number
}

export const DEFAULT_CLIENT_LIMITS: ClientLimits = CLIENT_LIMITS

export const CLIENT_CALL_REQUEST = z.looseObject({
  route: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  caller: z.looseObject({ userId: z.string().min(1), clientId: z.string().nullable().optional(), platform: z.string().nullable().optional() }),
  command: z.looseObject({ commandId: z.string().min(1), inputDigest: z.string().min(1), deadline: z.string() }).nullable().optional(),
  server: z.looseObject({}).nullable().optional(),
  byteBudget: z.number().int().nullable().optional(),
})

export const CLIENT_SUBSCRIBE_REQUEST = z.looseObject({
  stream: z.literal('terminal'),
  terminalId: z.string().min(1),
  fromSeq: z.number().int().min(0).optional(),
  caller: z.looseObject({ userId: z.string().min(1) }).nullable().optional(),
})

function invalid(message: string): MeshCallError {
  return new MeshCallError('invalid_argument', message)
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** `/api/v2/sessions/{session_id}/plans/{plan_id}` → a pattern where every `{name}` is one non-empty segment. */
function templatePattern(template: string): RegExp {
  const source = template
    .split(/(\{[^}]+\})/u)
    .map(part => (part.startsWith('{') ? '[^/?#]+' : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`, 'u')
}

const CALL_ROUTES: ReadonlyMap<string, { readonly entry: ClientRouteEntry; readonly pattern: RegExp }> = new Map(
  CLIENT_ROUTES.filter(entry => entry.via === 'call').map(entry => [entry.id, { entry, pattern: templatePattern(entry.path) }]),
)

/** A `.` or `..` segment, plain or percent-encoded, would let the path parser land on another route. */
function hasDotSegment(path: string): boolean {
  return path.split('/').some(segment => {
    try {
      const decoded = decodeURIComponent(segment)
      return decoded === '.' || decoded === '..'
    } catch {
      return true
    }
  })
}

/**
 * The table entry of a `Client/call`: the route must be one the device answers (`via: call`) and its method and
 * path must be the route's own; anything else is `invalid_argument`, before the call takes a lane.
 */
export function clientRoute(request: Record<string, unknown>): ClientRouteEntry {
  const id = typeof request.route === 'string' ? request.route : ''
  const known = CALL_ROUTES.get(id)
  if (known === undefined) throw invalid(`${id || '(none)'} is not a route this device answers`)
  if (request.method !== known.entry.method) throw invalid(`${id} is ${known.entry.method}, not ${String(request.method)}`)
  const path = typeof request.path === 'string' ? request.path : ''
  if (!known.pattern.test(path) || hasDotSegment(path)) throw invalid(`${path || '(none)'} is not a path of ${id}`)
  return known.entry
}

/**
 * The command identity of a request, checked against its route: a route with a receipt needs one, a route
 * without must not carry one. A body field the id comes from must agree with it; when it is missing the body
 * gets it, so the use case and the receipt share the id.
 */
function commandOf(route: ClientRouteEntry, request: ClientCallRequest, body: Record<string, unknown>): { command: ClientCommand | null; body: Record<string, unknown> } {
  const command = request.command ?? null
  const field = route.commandId
  if (field === null) {
    if (command !== null) throw invalid(`${route.id} has no receipt; it takes no command`)
    return { command: null, body }
  }
  if (command === null) throw invalid(`${route.id} needs a command`)
  if (field === GENERATED_COMMAND_ID) return { command, body }
  const value = body[field]
  if (value === undefined || value === null || value === '') return { command, body: { ...body, [field]: command.commandId } }
  if (value !== command.commandId) throw invalid(`${field} differs from command.commandId`)
  return { command, body }
}

function callerOf(request: ClientCallRequest): ChannelCaller {
  const caller = request.caller
  return { clientId: caller.clientId ?? `user:${caller.userId}`, label: caller.userId, platform: caller.platform ?? null }
}

function pathWithQuery(path: string, query: Record<string, string> | undefined): string {
  const search = new URLSearchParams(query ?? {}).toString()
  return search === '' ? path : `${path}?${search}`
}

function errorBody(status: number, code: string, message: string): { status: number; body: unknown } {
  return { status, body: { detail: { code, message } } }
}

/** The `{detail: {code, message}}` of an error body, as a command outcome error. */
function errorOf(body: unknown): NonNullable<ClientCommandOutcome['e']> {
  const detail = record(record(body).detail)
  const code = typeof detail.code === 'string' && detail.code !== '' ? detail.code : 'command_rejected'
  return { code, ...(typeof detail.message === 'string' ? { message: detail.message } : {}) }
}

function outcomeOf(commandId: string, ack: { outcome: 'accepted' | 'rejected'; e?: ClientCommandOutcome['e'] }): ClientCommandOutcome {
  if (ack.outcome === 'accepted') return { commandId, outcome: 'accepted' }
  const e = ack.e ?? { code: 'unknown' }
  return { commandId, outcome: 'rejected', e: { code: e.code, ...(e.message !== undefined ? { message: e.message } : {}), ...(e.retryable !== undefined ? { retryable: e.retryable } : {}) } }
}

/**
 * `Client/call`: answers one request through the tunnel API, then streams `ClientCallHead` and the body's chunks.
 * The command of a command route runs under `command.commandId` (a repeat replays the inbox's receipt) and its
 * outcome goes in `head.command`. Nothing here follows the call's cancellation: a command that started settles.
 */
export async function* clientCall(api: TunnelApi, raw: Record<string, unknown>, limits: ClientLimits = DEFAULT_CLIENT_LIMITS): AsyncGenerator<ClientCallHead | ClientCallChunk> {
  const request = raw as ClientCallRequest
  const route = clientRoute(raw)
  const checked = commandOf(route, request, record(request.body))
  const command = checked.command
  // Set from the tunnel's callback, hence a holder rather than a narrowed local.
  const settled: { outcome: ClientCommandOutcome | null } = { outcome: null }
  let response: { status: number; body: unknown; contentType?: string }
  if (Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8') > limits.maxRequestBodyBytes) {
    response = errorBody(413, 'request_too_large', `the request body exceeds ${limits.maxRequestBodyBytes} bytes`)
  } else {
    const context: TunnelCallContext = {
      ...(command !== null ? { command: { commandId: command.commandId, inputDigest: command.inputDigest, deadline: command.deadline } } : {}),
      ...(request.server !== undefined && request.server !== null ? { server: request.server } : {}),
      onCommand: (commandId, ack) => {
        settled.outcome = outcomeOf(commandId, ack)
      },
    }
    const tunnelRequest: TunnelApiRequest = { method: request.method, path: pathWithQuery(request.path, request.query), body: checked.body }
    response = await api.request(callerOf(request), tunnelRequest, context)
  }
  // Refused before the inbox saw it (validation, a missing session): nothing ran, so the receipt is rejected.
  // A 5xx without an ack leaves the outcome open; the Server asks `Commands/status`.
  if (command !== null && settled.outcome === null && response.status >= 400 && response.status < 500) {
    settled.outcome = { commandId: command.commandId, outcome: 'rejected', e: errorOf(response.body) }
  }
  // A text body goes as it is under its own media type; everything else is JSON.
  let contentType = response.contentType !== undefined && typeof response.body === 'string' ? response.contentType : 'application/json'
  let text = contentType === 'application/json' ? JSON.stringify(response.body ?? null) : response.body as string
  let status = response.status
  if (Buffer.byteLength(text, 'utf8') > limits.maxResponseBytes) {
    const tooLarge = errorBody(500, 'response_too_large', `the response body exceeds ${limits.maxResponseBytes} bytes`)
    status = tooLarge.status
    text = JSON.stringify(tooLarge.body)
    contentType = 'application/json'
  }
  yield { kind: 'head', status, contentType, ...(settled.outcome !== null ? { command: settled.outcome } : {}) }
  for (const chunk of chunkText(text, limits.maxChunkBytes)) yield { kind: 'chunk', ...chunk }
}

function streamItem(item: TerminalOutputItem): TerminalStreamItem {
  const p = item.p
  const seq = typeof p.seq === 'number' ? p.seq : null
  const data = typeof p.dataBase64 === 'string' ? p.dataBase64 : ''
  if (item.m === 'terminal.replay') return { type: 'replay', data, seq }
  if (item.m === 'terminal.output') return { type: 'output', data, seq }
  return { type: 'exit', exitCode: typeof p.exitCode === 'number' ? p.exitCode : null, reason: typeof p.reason === 'string' ? p.reason : 'exit' }
}

/**
 * `Client/subscribe {stream: "terminal"}`: the terminal WebSocket messages (`replay` first, then `output`, then
 * `exit`), read through the device's shared `TerminalWatchers`, so this reader joins the others of the terminal
 * and a slow one replays from the scrollback instead of queueing. Cancelling the call unsubscribes.
 */
export async function* clientSubscribe(watchers: TerminalWatchers, terminals: TerminalSource, raw: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<TerminalStreamItem> {
  const request = raw as ClientSubscribeRequest
  // The terminal's own scope (browse or session): the request names only the terminal.
  const current = await terminals.snapshot({ terminalId: request.terminalId }, false)
  const sessionId = record(current.terminal).sessionId
  if (typeof sessionId !== 'string' || sessionId === '') throw new MeshCallError('terminal_not_found', `terminal not found: ${request.terminalId}`)
  for await (const item of watchers.stream({ terminalId: request.terminalId, sessionId, ...(request.fromSeq !== undefined ? { fromSeq: request.fromSeq } : {}) }, signal)) {
    yield streamItem(item)
  }
}
