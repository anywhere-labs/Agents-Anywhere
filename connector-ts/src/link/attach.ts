import type { LiveEvents } from '../application/ports/index.js'
import { ATTACH_EVENTS as GENERATED_ATTACH_EVENTS } from '../generated/device-meshcall/v1_0/e2ee-registration.js'
import type { LinkAttachItem } from '../generated/device-meshcall/v1_0/link-attach-item.js'

/** Device heartbeat on `Link/attach` (06-protocols.md §2.5); the Server's lease is 60 s. */
export const HEARTBEAT_MS = 20_000
/** A held item not taken for this long means the holder gives no credit (device-meshcall README, `ATTACH_STALL_SECONDS`). */
export const ATTACH_STALL_MS = 40_000
/** Lossy events kept while no attach is open, or while the holder is slow. */
export const MAX_PENDING_EVENTS = 256

export type AttachEnd = 'cancelled' | 'superseded' | 'stalled' | 'closed'

/** Events allowed in plaintext on `Link/attach`, per E2EE mode (generated from `e2ee-registration.json`). */
export const ATTACH_EVENTS: Readonly<Record<'off' | 'required', readonly string[]>> = GENERATED_ATTACH_EVENTS

interface OpenStream {
  readonly id: number
  readonly connectionId: string
  ended: AttachEnd | null
  wake: (() => void) | null
  /** When the item now held by MeshCall was handed over; null while the generator runs. */
  heldSince: number | null
}

export interface AttachHubOptions {
  readonly heartbeatMs?: number
  readonly stallMs?: number
  readonly now?: () => number
  /** The attach stream of the current generation opened (a worker holds the device). */
  readonly onOpened?: (connectionId: string) => void
  /** It ended for `reason`; `cancelled` and `stalled` mean the device should call `ready` again. */
  readonly onEnded?: (connectionId: string, reason: AttachEnd) => void
}

function eventKey(method: string, payload: Record<string, unknown>): string {
  const scope = payload.sessionId ?? payload.runtimeId ?? payload.port ?? ''
  // Session facts of different kinds (planning, goal, status) share a session: one must not replace another.
  const status = payload.status
  const kind = status !== null && typeof status === 'object' && typeof (status as Record<string, unknown>).event === 'string' ? (status as Record<string, unknown>).event : ''
  return `${method}\u0000${String(scope)}\u0000${String(kind)}`
}

/**
 * `Link/attach` (06-protocols.md §2.5): one stream per connection generation, a heartbeat at once and every 20 s,
 * plus lossy current-state events. Events are coalesced by method and subject (the latest wins) and bounded, so a
 * slow holder costs memory only up to `MAX_PENDING_EVENTS`.
 *
 * MeshCall pulls the next item before it waits for credit, and a handler cannot end a call while MeshCall holds
 * its item. A holder that stops granting credit is therefore detected here (an item held longer than
 * `ATTACH_STALL_MS`), reported as `stalled`, and the stream ends as soon as MeshCall asks for the next item.
 */
export class AttachHub implements LiveEvents {
  private readonly pending = new Map<string, { method: string; payload: Record<string, unknown> }>()
  private current: OpenStream | null = null
  private nextId = 1
  private allowed: ReadonlySet<string> = new Set(ATTACH_EVENTS.off)
  private encrypted = false

  public constructor(private readonly options: AttachHubOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  public setMode(mode: 'off' | 'required'): void {
    this.allowed = new Set(ATTACH_EVENTS[mode])
    this.encrypted = mode === 'required'
    for (const [key, event] of this.pending) if (!this.passes(event.method, event.payload)) this.pending.delete(key)
  }

  public get isOpen(): boolean {
    return this.current !== null && this.current.ended === null
  }

  /**
   * In encrypted mode only device-level facts go out in plaintext: a session's facts (anything naming a
   * `sessionId`: notices, planning, configuration) reach clients through their secure channel subscriptions.
   */
  private passes(method: string, payload: Record<string, unknown>): boolean {
    return this.allowed.has(method) && !(this.encrypted && payload.sessionId !== undefined)
  }

  public emit(method: string, payload: Record<string, unknown>): void {
    if (!this.passes(method, payload)) return
    const key = eventKey(method, payload)
    this.pending.delete(key)
    this.pending.set(key, { method, payload })
    while (this.pending.size > MAX_PENDING_EVENTS) this.pending.delete(this.pending.keys().next().value as string)
    this.current?.wake?.()
  }

  /** Ends the open stream, if any (connection replaced, link closing). */
  public end(reason: AttachEnd = 'closed'): void {
    const stream = this.current
    if (stream === null || stream.ended !== null) return
    stream.ended = reason
    stream.wake?.()
  }

  /** Armed only while MeshCall holds an item of `stream`: an idle link runs no timer for this. */
  private armStall(stream: OpenStream): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.current !== stream || stream.ended !== null || stream.heldSince === null) return
      stream.ended = 'stalled'
      this.options.onEnded?.(stream.connectionId, 'stalled')
    }, this.options.stallMs ?? ATTACH_STALL_MS)
    timer.unref?.()
    return timer
  }

  public close(): void {
    this.end('closed')
  }

  /** The `Link/attach` handler body: a new stream ends the previous one (at most one per generation). */
  public async *open(connectionId: string, signal: AbortSignal): AsyncGenerator<LinkAttachItem> {
    const previous = this.current
    if (previous !== null && previous.ended === null) {
      previous.ended = 'superseded'
      previous.wake?.()
    }
    const stream: OpenStream = { id: this.nextId++, connectionId, ended: null, wake: null, heldSince: null }
    this.current = stream
    const heartbeatMs = this.options.heartbeatMs ?? HEARTBEAT_MS
    const onAbort = (): void => {
      if (stream.ended === null) stream.ended = 'cancelled'
      stream.wake?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const hand = async function* (this: AttachHub, item: LinkAttachItem): AsyncGenerator<LinkAttachItem> {
      stream.heldSince = this.now()
      const stall = this.armStall(stream)
      try {
        yield item
      } finally {
        clearTimeout(stall)
        stream.heldSince = null
      }
    }.bind(this)
    try {
      this.options.onOpened?.(connectionId)
      // The Server's `ready` waits for the first item before it answers.
      yield* hand({ kind: 'heartbeat' })
      let lastBeat = this.now()
      while (stream.ended === null && !signal.aborted) {
        const events = [...this.pending.values()]
        this.pending.clear()
        for (const event of events) {
          if (stream.ended !== null) {
            // Not sent: keep it for the next holder unless something newer arrived.
            const key = eventKey(event.method, event.payload)
            if (!this.pending.has(key)) this.pending.set(key, event)
            continue
          }
          yield* hand({ kind: 'event', m: event.method, p: event.payload })
        }
        if (stream.ended !== null) break
        const due = lastBeat + heartbeatMs - this.now()
        if (due <= 0) {
          yield* hand({ kind: 'heartbeat' })
          lastBeat = this.now()
          continue
        }
        if (this.pending.size > 0) continue
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, due)
          function done(): void {
            clearTimeout(timer)
            stream.wake = null
            resolve()
          }
          stream.wake = done
        })
      }
      if (stream.ended === null) stream.ended = 'cancelled'
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Every end this hub causes is recorded before it happens; anything else came from the Server's side
      // (the holder went away, MeshCall closed the iterator).
      if (stream.ended === null) stream.ended = 'cancelled'
      if (this.current === stream) this.current = null
      // `stalled` was reported by its timer already; `superseded` belongs to the stream that replaced it.
      if (stream.ended !== 'stalled' && stream.ended !== 'superseded') this.options.onEnded?.(connectionId, stream.ended)
    }
  }
}
