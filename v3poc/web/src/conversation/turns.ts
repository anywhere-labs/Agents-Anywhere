// From items to what the thread draws. Effi Cloud's rule: consecutive assistant items with the same turn_id are one
// reply (one AI Elements Message); a non-steered user message starts a turn; a steered one belongs to the turn it was
// sent into; a subagent's steps (items with subagent_id) are drawn inside that subagent, not in the reply.
import type { AssistantMessage, AssistantPart, Message, UserMessage } from '@protocol/timeline'

export interface TurnData {
  key: string
  user: UserMessage | null
  /** Assistant items, and user messages steered into this turn, in order. */
  items: Message[]
  /** Outgoing (optimistic) message: not pushed back yet. */
  outgoing?: boolean
  /** The steps of the subagents in this turn, by subagent part id. */
  sub: Map<string, AssistantMessage[]>
  /** The turn's first position (`seq`), for the window (store.trimHead). */
  firstSeq: number
}

export function turnsOf(messages: Message[], outgoing: UserMessage[]): { turns: TurnData[]; subagentSteps: Map<string, AssistantMessage[]> } {
  const turns: TurnData[] = []
  const subagentSteps = new Map<string, AssistantMessage[]>()
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.steered && turns.length) turns[turns.length - 1].items.push(m)
      // Keyed by client_msg_id when there is one, so the optimistic copy and the pushed item are the same element
      // (the scroller tracks items by key: a key change mid-anchor would lose the reader's place).
      else turns.push({ key: m.client_msg_id ?? m.id, user: m, items: [], sub: new Map(), firstSeq: m.seq })
      continue
    }
    if (m.subagent_id) {
      const list = subagentSteps.get(m.subagent_id) ?? []
      list.push(m)
      subagentSteps.set(m.subagent_id, list)
      continue
    }
    const last = turns[turns.length - 1]
    const turnId = last?.user?.id ?? last?.items.find((x): x is AssistantMessage => x.role === 'assistant')?.turn_id
    if (last && turnId === m.turn_id) last.items.push(m)
    else turns.push({ key: `t-${m.turn_id}`, user: null, items: [m], sub: new Map(), firstSeq: m.seq })
  }
  for (const o of outgoing) turns.push({ key: o.client_msg_id ?? o.id, user: o, items: [], outgoing: true, sub: new Map(), firstSeq: o.seq })
  for (const t of turns)
    for (const m of t.items) {
      const p = m.role === 'assistant' ? m.parts[0] : null
      if (p?.type === 'subagent') t.sub.set(p.id, subagentSteps.get(p.id) ?? [])
    }
  return { turns, subagentSteps }
}

const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * `turnsOf`, keeping the previous TurnData object for every turn whose items (and subagent steps) are the very same
 * objects as before. The store replaces only the item that changed, so a push re-renders its own turn and nothing else:
 * memoised turns get the same props, and the cost of an update does not grow with the length of the thread.
 */
export class TurnCache {
  private prev = new Map<string, TurnData>()

  build(messages: Message[], outgoing: UserMessage[]): TurnData[] {
    const { turns } = turnsOf(messages, outgoing)
    const next = new Map<string, TurnData>()
    const out = turns.map((t) => {
      const p = this.prev.get(t.key)
      const same =
        p &&
        p.user === t.user &&
        p.outgoing === t.outgoing &&
        sameList(p.items, t.items) &&
        p.sub.size === t.sub.size &&
        [...t.sub].every(([k, v]) => p.sub.has(k) && sameList(p.sub.get(k)!, v))
      const kept = same ? p : t
      next.set(t.key, kept)
      return kept
    })
    this.prev = next
    return out
  }
}

/** A step of the agent's work: folded with its neighbours into one group ("想了 2 次，运行了 3 条命令"). */
export type Step = AssistantMessage & { parts: [Extract<AssistantPart, { type: 'thinking' | 'tool' | 'subagent' | 'plan' }>] }

export type Segment =
  | { kind: 'steps'; key: string; steps: Step[] }
  | { kind: 'text'; key: string; message: AssistantMessage; text: string }
  | { kind: 'compaction'; key: string; message: AssistantMessage }
  | { kind: 'steer'; key: string; message: UserMessage }

const isStep = (m: AssistantMessage): m is Step => ['thinking', 'tool', 'subagent', 'plan'].includes(m.parts[0].type)

/**
 * A reply in order, as Effi Cloud draws it: what the agent says (text, a compaction) as it is, and every stretch of
 * steps between two of those (thinking, tools, subagents, the plan) as one group. Permission requests are drawn by the tool step they belong to.
 */
export function segmentsOf(items: Message[]): Segment[] {
  const out: Segment[] = []
  for (const m of items) {
    if (m.role === 'user') {
      out.push({ kind: 'steer', key: m.id, message: m })
      continue
    }
    const part = m.parts[0]
    if (part.type === 'text') {
      if (part.text.trim() || !m.done) out.push({ kind: 'text', key: m.id, message: m, text: part.text })
      continue
    }
    if (part.type === 'compaction') {
      out.push({ kind: 'compaction', key: m.id, message: m })
      continue
    }
    if (!isStep(m)) continue
    if (part.type === 'thinking' && !part.text.trim() && m.done) continue
    const last = out[out.length - 1]
    if (last?.kind === 'steps') last.steps.push(m)
    else out.push({ kind: 'steps', key: m.id, steps: [m] })
  }
  return out
}

/** The reply's words, for 复制. */
export function replyText(items: Message[]): string {
  return items
    .flatMap((m) => (m.role === 'assistant' && m.parts[0].type === 'text' ? [m.parts[0].text] : []))
    .filter((t) => t.trim())
    .join('\n\n')
}

export function userText(m: UserMessage): string {
  return m.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n\n')
}
