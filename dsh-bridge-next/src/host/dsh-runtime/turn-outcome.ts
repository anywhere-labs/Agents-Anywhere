import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { itemId, sessionId, userMessageId } from './identity.js'
import { record } from './types.js'

/**
 * A finished turn the user must be told about: it failed, or it ended normally
 * without producing anything visible. Without this a client sees the session
 * return to idle with no reply and no explanation (#543).
 */
export interface TurnOutcome {
  kind: 'failed' | 'no_reply'
  /** Seq of the `turn/end` that closed the turn; keys the notice. */
  endSeq: number
  /** Native `TurnEndReason.kind`. */
  reason: string
  /** Steps (model calls) the turn entered; 0 means the model was never called. */
  steps: number
  error?: { code: string, message: string }
  /** DSH would continue this failed turn without a new message. */
  continuable?: boolean
}

/** Card action that asks DSH to continue a failed turn instead of resending the message. */
export const CONTINUE_ACTION = 'continue'

/** Card identity of the turn closed by the `turn/end` at `endSeq`. */
export function turnOutcomeNoticeId(platformId: string, endSeq: number): string {
  return itemId(platformId, 'turn-outcome', String(endSeq))
}

/** Prompt identity that continues the turn closed at `endSeq`; DSH admits it once. */
export function continuationRequestId(externalId: string, endSeq: number): string {
  return userMessageId(externalId, `continue:${endSeq}`)
}

/** Reasons that end a turn on the user's request or by bookkeeping, never by surprise. */
const SILENT_REASONS = new Set(['aborted', 'interrupted', 'forked'])

function visibleOutput(event: SessionEvent): boolean {
  if (event.type === 'tool/call') return true
  if (event.type !== 'assistant/message') return false
  return event.data.message.content.some(block => block.type === 'tool-call' || block.type === 'image'
    || (block.type === 'text' && block.text.trim().length > 0))
}

/** Outcome of the turn closed at `endIndex`, or undefined when it needs no notice. */
function outcomeAt(events: readonly SessionEvent[], endIndex: number): TurnOutcome | undefined {
  const end = events[endIndex]
  if (end?.type !== 'turn/end') return undefined
  const reason = end.data.reason
  if (SILENT_REASONS.has(reason.kind)) return undefined
  let steps = 0, replied = false
  for (let index = endIndex - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start' || event.type === 'turn/end') break
    if (event.type === 'step/start') steps++
    if (visibleOutput(event)) replied = true
  }
  const base = { endSeq: Number(end.seq), reason: reason.kind, steps }
  if (reason.kind === 'error') {
    const failure = record(reason.error)
    return { ...base, kind: 'failed', error: {
      code: typeof failure.code === 'string' && failure.code ? failure.code : 'UNKNOWN',
      message: typeof failure.message === 'string' ? failure.message : '',
    } }
  }
  return replied ? undefined : { ...base, kind: 'no_reply' }
}

/** Outcome of the turn closed by the `turn/end` at `endSeq`. */
export function turnOutcome(events: readonly SessionEvent[], endSeq: number): TurnOutcome | undefined {
  return outcomeAt(events, events.findLastIndex(event => Number(event.seq) === endSeq))
}

/**
 * Outcome of the latest turn that ended before `beforeSeq` (default: the whole
 * log), when no turn has started since. A started turn replaces the notice.
 */
export function latestTurnOutcome(events: readonly SessionEvent[], beforeSeq = Infinity): TurnOutcome | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (Number(event.seq) >= beforeSeq) continue
    if (event.type === 'turn/start') return undefined
    if (event.type === 'turn/end') return outcomeAt(events, index)
  }
  return undefined
}

/**
 * A non-blocking error card, like Codex's failed-turn notice: the turn is
 * already over, so the composer stays usable and the next turn closes it.
 * A failure DSH can continue offers to do so without resending the message.
 */
export function turnOutcomeNotice(namespace: string, externalId: string, outcome: TurnOutcome, status: 'open' | 'closed' = 'open') {
  const platformId = sessionId(namespace, externalId)
  const failed = outcome.kind === 'failed'
  const continuable = status === 'open' && outcome.continuable === true
  return {
    noticeId: turnOutcomeNoticeId(platformId, outcome.endSeq), sessionId: platformId, runtime: 'dsh',
    type: 'interaction', interactionType: 'execution_error',
    title: failed ? 'DSH 本轮执行失败' : 'DSH 本轮没有回复',
    message: failed
      ? outcome.error?.message || '本轮执行失败，没有生成回复。'
      : outcome.steps === 0
        ? '本轮已结束，但没有调用模型，也没有生成回复。可以重新发送这条消息。'
        : '本轮已结束，但模型没有生成任何回复。可以重新发送或换个说法再试。',
    severity: failed ? 'error' : 'warning', status, responseRequired: false, blocking: null,
    actions: continuable ? [{ actionId: CONTINUE_ACTION, label: '继续', style: 'primary' }] : [],
    source: { runtime: 'dsh', component: 'dsh.turn' },
    context: { kind: 'execution_error', outcome: outcome.kind, turnEndReason: outcome.reason, steps: outcome.steps,
      ...(outcome.error ? { error: outcome.error } : {}) },
    metadata: { source: failed ? 'dsh.turn.failed' : 'dsh.turn.no_reply', turnEndSeq: outcome.endSeq },
  }
}
