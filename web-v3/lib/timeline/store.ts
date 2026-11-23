// Client-side timeline store adapted from v3poc/web/src/timeline/store.ts:
// snapshot + whole-item replacement by id, optimistic outgoing sends (`client_msg_id`),
// pending/answered permission request memory, and turn-boundary head windowing.

import type {
  Control,
  Message,
  PendingRequest,
  Session,
  UserMessage,
  WatchEvent,
} from "@/lib/types/v3"

export interface TimelineState {
  session: Session | null
  messages: Message[]
  has_more: boolean
  control: Control | null
  outgoing: UserMessage[]
  requests: Record<string, PendingRequest>
  loadingOlder: boolean
  epoch: number
  floorSeq?: number
}

export const EMPTY_TIMELINE: TimelineState = {
  session: null,
  messages: [],
  has_more: false,
  control: null,
  outgoing: [],
  requests: {},
  loadingOlder: false,
  epoch: 0,
}

export const TIMELINE_WINDOW = { normal: 200, warning: 120, critical: 60 }
export const WINDOW = TIMELINE_WINDOW

function startsTurn(list: Message[], i: number): boolean {
  const m = list[i]
  if (m.role === "user") return !m.steered
  if (i === 0) return true
  const prev = list[i - 1]
  return prev.role === "assistant" ? prev.turn_id !== m.turn_id : prev.id !== m.turn_id
}

export function headCut(list: Message[], limit: number, protectedSeq = Infinity): number {
  if (list.length <= limit) return 0
  let cut = list.length - limit
  const last = list.length - 1
  let stop = list.findIndex((m) => m.seq >= protectedSeq)
  if (stop < 0) stop = last
  let newest = last
  while (newest > 0 && !startsTurn(list, newest)) newest--
  cut = Math.min(cut, stop, newest)
  while (cut > 0 && !startsTurn(list, cut)) cut--
  return cut
}

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

function rememberRequests(
  requests: Record<string, PendingRequest>,
  control: Control | null
): Record<string, PendingRequest> {
  if (!control?.pending.length) return requests
  const next = { ...requests }
  for (const p of control.pending) next[p.request_id] = p
  return next
}

function dropOutgoing(outgoing: UserMessage[], m: Message): UserMessage[] {
  if (m.role !== "user" || !m.client_msg_id || !outgoing.length) return outgoing
  return outgoing.filter((o) => o.client_msg_id !== m.client_msg_id)
}

export function applyWatchEvent(s: TimelineState, e: WatchEvent): TimelineState {
  switch (e.type) {
    case "snapshot": {
      let messages = [...e.messages].sort((a, b) => a.seq - b.seq)
      const cut = headCut(messages, TIMELINE_WINDOW.normal)
      if (cut > 0) messages = messages.slice(cut)
      const ids = new Set(
        messages.flatMap((m) => (m.role === "user" && m.client_msg_id ? [m.client_msg_id] : []))
      )
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
    case "message":
    case "item": {
      if (s.floorSeq !== undefined && e.message.seq < s.floorSeq) return s
      return {
        ...s,
        messages: upsert(s.messages, e.message),
        outgoing: dropOutgoing(s.outgoing, e.message),
      }
    }
    case "control": {
      const queuedIds = new Set(e.control.queued.map((q) => q.client_msg_id))
      return {
        ...s,
        control: e.control,
        outgoing: s.outgoing.filter((o) => !queuedIds.has(o.client_msg_id!)),
        requests: rememberRequests(s.requests, e.control),
      }
    }
    case "session":
      return { ...s, session: e.session }
  }
}

export function prependOlderMessages(
  s: TimelineState,
  older: Message[],
  hasMore: boolean
): TimelineState {
  if (!older.length) return { ...s, has_more: hasMore, loadingOlder: false }
  const seen = new Set(s.messages.map((m) => m.id))
  const merged = [...older.filter((m) => !seen.has(m.id)), ...s.messages].sort(
    (a, b) => a.seq - b.seq
  )
  return {
    ...s,
    messages: merged,
    has_more: hasMore,
    floorSeq: merged[0]?.seq,
    loadingOlder: false,
  }
}

export function trimTimelineHead(
  s: TimelineState,
  limit = TIMELINE_WINDOW.normal,
  protectedSeq = Infinity
): TimelineState {
  const cut = headCut(s.messages, limit, protectedSeq)
  if (cut <= 0) return s
  const messages = s.messages.slice(cut)
  return {
    ...s,
    messages,
    has_more: true,
    floorSeq: messages[0]?.seq,
  }
}

export class TimelineStore {
  private state: TimelineState = EMPTY_TIMELINE
  private listeners = new Set<() => void>()

  snapshot = (): TimelineState => this.state
  get = (): TimelineState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private commit(next: TimelineState) {
    if (next === this.state) return
    this.state = next
    for (const l of this.listeners) l()
  }

  apply(event: WatchEvent) {
    this.commit(applyWatchEvent(this.state, event))
  }

  addOutgoing(message: UserMessage) {
    this.commit({ ...this.state, outgoing: [...this.state.outgoing, message] })
  }

  removeOutgoing(clientMsgId: string) {
    this.commit({
      ...this.state,
      outgoing: this.state.outgoing.filter((m) => m.client_msg_id !== clientMsgId),
    })
  }

  setLoadingOlder(loading: boolean) {
    this.commit({ ...this.state, loadingOlder: loading })
  }

  prependOlder(messages: Message[], hasMore: boolean) {
    this.commit(prependOlderMessages(this.state, messages, hasMore))
  }

  trim(limit = TIMELINE_WINDOW.normal, protectedSeq = Infinity) {
    this.commit(trimTimelineHead(this.state, limit, protectedSeq))
  }

  trimHead(limit = TIMELINE_WINDOW.normal, protectedSeq = Infinity) {
    this.trim(limit, protectedSeq)
  }

  reset() {
    this.commit(EMPTY_TIMELINE)
  }
}
