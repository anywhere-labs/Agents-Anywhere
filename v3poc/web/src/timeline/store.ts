// The client side of `watch`: a snapshot, then whole values replaced by id. The same store backs the web demo and the
// mobile renderer (which gets the host's watch events forwarded unchanged), so both draw from identical state.
import type { Control, Message, PendingRequest, Session, UserMessage, WatchEvent } from '@protocol/timeline'

export interface TimelineState {
  session: Session | null
  /** Items in `seq` order. */
  messages: Message[]
  has_more: boolean
  control: Control | null
  /** Sent from here, not pushed back yet: replaced when an item with the same `client_msg_id` arrives. */
  outgoing: UserMessage[]
  /**
   * Every permission request seen pending in this session, by id. `control.answered` only names the request, so this is
   * how an answered one is put back under its tool call ("已由 X 在 Y 上处理").
   */
  requests: Record<string, PendingRequest>
  /** A page of older items is being fetched. */
  loadingOlder: boolean
  /** Bumped on every snapshot: a different session (or a resync) — views reset their scroll and folds. */
  epoch: number
  /**
   * The window: items below this seq were let go (`trimHead`) to keep memory bounded, and come back through
   * `list_messages({before_seq})` like any older page (`has_more` is true then). A push for an item below it is
   * ignored: that item is not on the page, and the next older page brings its current value.
   */
  floorSeq?: number
}

export const EMPTY: TimelineState = {
  session: null,
  messages: [],
  has_more: false,
  control: null,
  outgoing: [],
  requests: {},
  loadingOlder: false,
  epoch: 0,
}

/** Items kept at most, as whole turns (the protocol's snapshot is "the last ~100 items, never cutting a turn"). */
export const WINDOW = { normal: 200, warning: 120, critical: 60 }

/** Where a turn starts: a person's message (not steered into a running turn), or a new turn_id. */
function startsTurn(list: Message[], i: number) {
  const m = list[i]
  if (m.role === 'user') return !m.steered
  if (i === 0) return true
  const prev = list[i - 1]
  return prev.role === 'assistant' ? prev.turn_id !== m.turn_id : prev.id !== m.turn_id
}

/**
 * Where to cut the head so that about `limit` items stay, on a turn boundary, never at or after `protectedSeq` (the
 * turn the reader is looking at, or the newest turn). 0: nothing to cut.
 */
export function headCut(list: Message[], limit: number, protectedSeq = Infinity): number {
  if (list.length <= limit) return 0
  let cut = list.length - limit
  const last = list.length - 1
  let stop = list.findIndex((m) => m.seq >= protectedSeq)
  if (stop < 0) stop = last
  // The newest turn always stays.
  let newest = last
  while (newest > 0 && !startsTurn(list, newest)) newest--
  cut = Math.min(cut, stop, newest)
  while (cut > 0 && !startsTurn(list, cut)) cut--
  return cut
}

/** Insert or replace by id, keeping `seq` order. Pushed items are almost always the last one or a new last one. */
function upsert(list: Message[], m: Message): Message[] {
  let at = list.length - 1
  while (at >= 0 && list[at].id !== m.id) at--
  if (at >= 0) {
    if (list[at].seq === m.seq) {
      const next = list.slice()
      next[at] = m
      return next
    }
    list = list.filter((_, i) => i !== at)
  }
  let i = list.length
  while (i > 0 && list[i - 1].seq > m.seq) i--
  return [...list.slice(0, i), m, ...list.slice(i)]
}

function rememberRequests(requests: Record<string, PendingRequest>, control: Control | null) {
  if (!control?.pending.length) return requests
  const next = { ...requests }
  for (const p of control.pending) next[p.request_id] = p
  return next
}

function dropOutgoing(outgoing: UserMessage[], m: Message) {
  if (m.role !== 'user' || !m.client_msg_id || !outgoing.length) return outgoing
  return outgoing.filter((o) => o.client_msg_id !== m.client_msg_id)
}

export function applyWatch(s: TimelineState, e: WatchEvent): TimelineState {
  switch (e.type) {
    case 'snapshot': {
      let messages = [...e.messages].sort((a, b) => a.seq - b.seq)
      // A snapshot larger than the window (the host sent more than the protocol's ~100): keep the newest turns, the
      // reader opens at the end. The rest comes back as older pages.
      const cut = headCut(messages, WINDOW.normal)
      if (cut > 0) messages = messages.slice(cut)
      const ids = new Set(messages.flatMap((m) => (m.role === 'user' && m.client_msg_id ? [m.client_msg_id] : [])))
      const sameSession = s.session?.id === e.session.id
      return {
        session: e.session,
        messages,
        has_more: e.has_more || cut > 0,
        floorSeq: cut > 0 ? messages[0].seq : undefined,
        control: e.control,
        outgoing: sameSession ? s.outgoing.filter((o) => !ids.has(o.client_msg_id!)) : [],
        requests: rememberRequests(sameSession ? s.requests : {}, e.control),
        loadingOlder: false,
        epoch: s.epoch + 1,
      }
    }
    case 'message':
      if (s.floorSeq !== undefined && e.message.seq < s.floorSeq) return { ...s, outgoing: dropOutgoing(s.outgoing, e.message) }
      return { ...s, messages: upsert(s.messages, e.message), outgoing: dropOutgoing(s.outgoing, e.message) }
    case 'session':
      return { ...s, session: e.session }
    case 'control':
      return { ...s, control: e.control, requests: rememberRequests(s.requests, e.control) }
  }
}

/** A page of older items (`list_messages({before_seq})`), prepended. */
export function applyOlder(s: TimelineState, messages: Message[], has_more: boolean): TimelineState {
  const known = new Set(s.messages.map((m) => m.id))
  const fresh = messages.filter((m) => !known.has(m.id))
  const all = [...fresh, ...s.messages].sort((a, b) => a.seq - b.seq)
  return { ...s, messages: all, has_more, loadingOlder: false, floorSeq: has_more && all.length ? all[0].seq : undefined }
}

/** Let go of the head (see `headCut`); it comes back as older pages. */
export function trimHead(s: TimelineState, limit: number, protectedSeq?: number): TimelineState {
  const cut = headCut(s.messages, limit, protectedSeq)
  if (cut <= 0) return s
  const messages = s.messages.slice(cut)
  return { ...s, messages, has_more: true, floorSeq: messages[0].seq }
}

/** A minimal external store (useSyncExternalStore) around the reducer. */
export class TimelineStore {
  private state: TimelineState = EMPTY
  private listeners = new Set<() => void>()

  get = () => this.state
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(next: TimelineState) {
    if (next === this.state) return
    this.state = next
    for (const fn of this.listeners) fn()
  }

  watch(events: WatchEvent[]) {
    let s = this.state
    for (const e of events) s = applyWatch(s, e)
    this.set(s)
  }

  older(messages: Message[], has_more: boolean) {
    this.set(applyOlder(this.state, messages, has_more))
  }

  trimHead(limit: number, protectedSeq?: number) {
    this.set(trimHead(this.state, limit, protectedSeq))
  }

  setLoadingOlder(loading: boolean) {
    this.set({ ...this.state, loadingOlder: loading })
  }

  /** Show a message the moment it is sent; the pushed item carrying its client_msg_id replaces it. */
  addOutgoing(m: UserMessage) {
    this.set({ ...this.state, outgoing: [...this.state.outgoing, m] })
  }

  reset() {
    this.set({ ...EMPTY, epoch: this.state.epoch + 1 })
  }
}
