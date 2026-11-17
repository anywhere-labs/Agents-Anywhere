import { describe, expect, it } from 'vitest'

import {
  ConversationError,
  INITIAL_CLOCK,
  allocate,
  applySeqFloor,
  catchUp,
  decideUpsert,
  delivery,
  eventCursor,
  interaction,
  orderSeqOf,
  parseEventCursor,
  previewOf,
  queue,
  raiseResetFence,
  summarize,
  summaryChanged,
  timelineContentHash,
  admitMessage,
  admitSteer,
  startTurn,
  validateClock,
  type Session,
  type TimelineDraft,
  type TimelineItem,
} from '../../src/domain/conversation/index.js'

describe('session clock', () => {
  it('allocates consecutive sequence numbers', () => {
    const first = allocate(INITIAL_CLOCK, 3)
    expect(first).toEqual({ clock: { headSeq: 3, resetSeq: 0 }, first: 1, last: 3 })
    expect(allocate(first.clock, 1).first).toBe(4)
  })

  it('raises the fence on a position of its own so a snapshot right after a reset is valid', () => {
    const clock = raiseResetFence({ headSeq: 10, resetSeq: 0 })
    expect(clock).toEqual({ headSeq: 11, resetSeq: 11 })
    validateClock(clock)
    expect(catchUp(clock, 10)).toEqual({ kind: 'snapshot_required', reason: 'before_reset' })
    expect(catchUp(clock, 11)).toEqual({ kind: 'up_to_date' })
    expect(catchUp(allocate(clock, 2).clock, 11)).toEqual({ kind: 'incremental' })
  })

  it('jumps past the Server floor after a store loss and asks for a restamp', () => {
    expect(applySeqFloor({ headSeq: 5, resetSeq: 0 }, 1203)).toEqual({ clock: { headSeq: 1204, resetSeq: 1204 }, restamp: true })
    expect(applySeqFloor({ headSeq: 2000, resetSeq: 3 }, 1203)).toEqual({ clock: { headSeq: 2000, resetSeq: 3 }, restamp: false })
    // A client that saw seq:1203 from the lost store must refetch; nothing it saw can look newer.
    expect(catchUp({ headSeq: 1204, resetSeq: 1204 }, 1203).kind).toBe('snapshot_required')
  })

  it('refuses cursors from a newer store', () => {
    expect(catchUp({ headSeq: 4, resetSeq: 0 }, 9)).toEqual({ kind: 'snapshot_required', reason: 'ahead_of_device' })
  })

  it('keeps the v2 cursor format', () => {
    expect(eventCursor(42)).toBe('seq:42')
    expect(parseEventCursor('seq:0')).toBe(0)
    expect(() => parseEventCursor('seq:01')).toThrow(ConversationError)
    expect(() => parseEventCursor('42')).toThrow(ConversationError)
  })
})

const draft = (patch: Partial<TimelineDraft> = {}): TimelineDraft => ({
  id: 'tl_1',
  type: 'message',
  status: 'done',
  role: 'user',
  orderSeq: orderSeqOf(3),
  content: { text: 'hi' },
  source: { runtime: 'codex' },
  createdAt: '2026-11-16T00:00:00.000Z',
  ...patch,
})

describe('timeline', () => {
  it('matches v2 timeline_content_hash byte for byte', () => {
    // Expected values come from connector/connector/runtime_protocol/timeline.py (Python 3).
    expect(timelineContentHash('message', 'done', 'user', { text: '你好 world', clientMessageId: 'm1' }))
      .toBe('sha256:5fe08520ab1d16a60c06462ade233ed46c8a1731dfe72ff3ac347fbbd3c83e00')
    expect(timelineContentHash('tool', 'running', null, { name: 'bash', input: { cmd: 'ls -la', n: 1.5, big: 1e16 } }))
      .toBe('sha256:cdcf1531e7c3f320c2a9a1f689cd2e1892221baaacbe24022ad5f886d650b82b')
    expect(timelineContentHash('message', 'done', 'assistant', { text: 'a\ud800b' }))
      .toBe('sha256:05debb964d24db73bead5467b27bb9c911707e2426158f5ef70465382c299d8b')
  })

  it('positions sub-items inside a native record', () => {
    expect(orderSeqOf(2, 5)).toBe(2053)
    expect(() => orderSeqOf(1, 1024)).toThrow(ConversationError)
  })

  it('does not tick for an identical replay and keeps createdAt on updates', () => {
    const inserted = decideUpsert('sess_1', undefined, draft())
    expect(inserted.kind).toBe('insert')
    const stored: TimelineItem = { ...(inserted.item as TimelineItem), updatedSeq: 1, updatedAt: 't1' }
    expect(decideUpsert('sess_1', stored, draft()).kind).toBe('unchanged')
    const updated = decideUpsert('sess_1', stored, draft({ content: { text: 'hi!' }, createdAt: 'later' }))
    expect(updated.kind).toBe('update')
    expect(updated.item.revision).toBe(2)
    expect(updated.item.createdAt).toBe('2026-11-16T00:00:00.000Z')
  })

  it('rejects malformed drafts', () => {
    expect(() => decideUpsert('s', undefined, draft({ id: '' }))).toThrow(ConversationError)
    expect(() => decideUpsert('s', undefined, draft({ type: 'bogus' as 'message' }))).toThrow(ConversationError)
  })
})

describe('delivery', () => {
  const base = { sessionId: 's', clientMessageId: 'm1', inputDigest: 'd1', at: 't0', queued: false }

  it('is idempotent by clientMessageId and refuses a different message under the same id', () => {
    const first = delivery.receive(undefined, base)
    expect(first.kind).toBe('new')
    expect(delivery.receive(first.delivery, base).kind).toBe('duplicate')
    expect(() => delivery.receive(first.delivery, { ...base, inputDigest: 'd2' })).toThrow(expect.objectContaining({ code: 'delivery_conflict' }))
  })

  it('never resends an unknown outcome on its own', () => {
    const accepted = delivery.receive(undefined, base).delivery
    const sending = delivery.transition(accepted, 'sending', 't1')
    const unknown = delivery.recoverAfterRestart(sending, false, 't2')
    expect(unknown.state).toBe('unknown')
    expect(() => delivery.transition(unknown, 'sending', 't3')).toThrow(ConversationError)
    expect(delivery.requeueForRetry(unknown, 't3').state).toBe('queued')
    expect(delivery.recoverAfterRestart(sending, true, 't2').state).toBe('started')
  })
})

describe('interaction', () => {
  const opened = interaction.open({ sessionId: 's', noticeId: 'n1', kind: 'approval', blocking: true, payload: {}, at: 't0' })

  it('takes the first answer only', () => {
    const first = interaction.respond(opened, 'r1')
    expect(first.kind).toBe('accepted')
    expect(interaction.respond(first.interaction, 'r1').kind).toBe('duplicate')
    expect(() => interaction.respond(first.interaction, 'r2')).toThrow(expect.objectContaining({ code: 'interaction_conflict' }))
    expect(() => interaction.respond(undefined, 'r1')).toThrow(expect.objectContaining({ code: 'interaction_not_found' }))
  })

  it('closes blocking interactions when the turn ends', () => {
    const informational = interaction.open({ sessionId: 's', noticeId: 'n2', kind: 'execution_error', blocking: false, payload: {}, at: 't0' })
    expect(interaction.closedByTurnEnd([opened, informational]).map(i => i.noticeId)).toEqual(['n1'])
    expect(interaction.expire(opened, 'turn_ended', 't1')).toMatchObject({ state: 'expired', resolution: 'turn_ended' })
  })

  it('reopens after a forwarding failure', () => {
    const responding = interaction.respond(opened, 'r1').interaction
    expect(interaction.reopen(responding)).toMatchObject({ state: 'open', responseId: null })
  })
})

const item = (id: string) => ({ messageId: id, sessionId: 's', clientMessageId: `c_${id}`, content: id, attachments: [], createdBy: 'u', createdAt: 't', updatedAt: 't' })

describe('queue', () => {
  it('dedupes by clientMessageId and caps at 20 items', () => {
    let q = queue.emptyQueue('s')
    for (let i = 0; i < 20; i++) q = queue.enqueue(q, item(`q${i}`), 'auto').queue
    expect(queue.enqueue(q, item('q3'), 'auto').duplicate).toBe(true)
    expect(() => queue.enqueue(q, item('q20'), 'auto')).toThrow(expect.objectContaining({ code: 'queue_full' }))
    expect(q.revision).toBe(20)
    expect(queue.queueState(q).items[2]?.position).toBe(3)
  })

  it('puts interrupting messages behind the item being sent', () => {
    let q = queue.enqueue(queue.emptyQueue('s'), item('a'), 'auto').queue
    q = queue.markSending(q, 'a', 't')
    q = queue.enqueue(q, item('b'), 'auto').queue
    q = queue.enqueue(q, item('c'), 'interrupt').queue
    expect(q.items.map(i => i.messageId)).toEqual(['a', 'c', 'b'])
    expect(() => queue.update(q, 'a', { content: 'x' }, 't')).toThrow(expect.objectContaining({ code: 'queue_item_sending' }))
    expect(() => queue.reorder(q, ['c', 'a', 'b'])).toThrow(expect.objectContaining({ code: 'queue_order_mismatch' }))
    expect(() => queue.reorder(q, ['a', 'c'])).toThrow(expect.objectContaining({ code: 'queue_order_mismatch' }))
    expect(queue.reorder(q, ['a', 'b', 'c']).items.map(i => i.messageId)).toEqual(['a', 'b', 'c'])
    expect(queue.clear(q).queue.items.map(i => i.messageId)).toEqual(['a'])
  })

  it('dispatches only the head, only when idle, and stops at a failed head', () => {
    const session = { status: 'idle', takeover: true, archived: false }
    let q = queue.enqueue(queue.enqueue(queue.emptyQueue('s'), item('a'), 'auto').queue, item('b'), 'auto').queue
    expect(queue.nextDispatch(q, { ...session, status: 'running' })).toEqual({ kind: 'wait', reason: 'busy' })
    expect(queue.nextDispatch(q, session)).toMatchObject({ kind: 'dispatch', item: { messageId: 'a' } })
    q = queue.markFailed(queue.markSending(q, 'a', 't'), 'a', { code: 'runtime_error', message: 'x' }, 't')
    expect(queue.nextDispatch(q, session)).toEqual({ kind: 'wait', reason: 'head_failed' })
    q = queue.retry(q, 'a', 't')
    expect(queue.nextDispatch(q, session).kind).toBe('dispatch')
    expect(queue.nextDispatch(q, { ...session, takeover: false })).toEqual({ kind: 'wait', reason: 'not_taken_over' })
  })

  it('pauses after an errored turn until the user resumes', () => {
    const session = { status: 'idle', takeover: true, archived: false }
    let q = queue.onTurnEnded(queue.enqueue(queue.emptyQueue('s'), item('a'), 'auto').queue, 'error')
    expect(queue.nextDispatch(q, session)).toEqual({ kind: 'wait', reason: 'paused' })
    q = queue.resume(q)
    expect(queue.nextDispatch(q, session).kind).toBe('dispatch')
  })

  it('asks for an interrupt when the head requested one and the session is busy', () => {
    const q = queue.enqueue(queue.emptyQueue('s'), item('a'), 'interrupt').queue
    expect(queue.nextDispatch(q, { status: 'running', takeover: true, archived: false })).toMatchObject({ kind: 'interrupt' })
  })

  it('fails a crashed dispatch without evidence and never resends it', () => {
    const q = queue.markSending(queue.enqueue(queue.emptyQueue('s'), item('a'), 'auto').queue, 'a', 't')
    expect(queue.recoverSending(q, () => false, 't2').items[0]).toMatchObject({ status: 'failed', error: { code: 'queue_dispatch_unknown' } })
    expect(queue.recoverSending(q, () => true, 't2').items).toEqual([])
  })
})

describe('admission', () => {
  it('follows the v2 queue table', () => {
    expect(admitMessage({ status: 'idle', queueLength: 0, queue: null, queueAvailable: true })).toEqual({ kind: 'dispatch' })
    expect(admitMessage({ status: 'running', queueLength: 0, queue: null, queueAvailable: true })).toMatchObject({ kind: 'reject', legacy: true })
    expect(admitMessage({ status: 'running', queueLength: 0, queue: 'never', queueAvailable: true })).toMatchObject({ kind: 'reject', legacy: false })
    expect(admitMessage({ status: 'running', queueLength: 0, queue: 'auto', queueAvailable: true })).toEqual({ kind: 'enqueue', interrupt: false })
    expect(admitMessage({ status: 'idle', queueLength: 2, queue: 'auto', queueAvailable: true })).toEqual({ kind: 'enqueue', interrupt: false })
    expect(admitMessage({ status: 'waiting_approval', queueLength: 0, queue: 'interrupt', queueAvailable: true })).toEqual({ kind: 'enqueue', interrupt: true })
    expect(admitMessage({ status: 'error', queueLength: 0, queue: null, queueAvailable: true })).toEqual({ kind: 'dispatch' })
  })

  it('steers only into a running turn', () => {
    expect(() => admitSteer({ status: 'running', steerSupported: true })).not.toThrow()
    expect(() => admitSteer({ status: 'idle', steerSupported: true })).toThrow(ConversationError)
    expect(() => admitSteer({ status: 'running', steerSupported: false })).toThrow(ConversationError)
  })

  it('keeps one active turn per session', () => {
    const turn = { turnId: 't1', clientMessageId: 'm1', startedAt: 'x' }
    expect(startTurn(null, turn)).toBe(turn)
    expect(startTurn(turn, turn)).toBe(turn)
    expect(() => startTurn(turn, { ...turn, turnId: 't2' })).toThrow(expect.objectContaining({ code: 'session_busy' }))
  })
})

describe('summary', () => {
  const session: Session = {
    sessionId: 's', runtimeType: 'codex', runtimeId: 'rti_1', externalSessionId: 'th_1', cwd: '/w', nativeTitle: 'T',
    status: 'idle', sourceAvailability: 'available', clock: { headSeq: 9, resetSeq: 0 }, activeTurn: null, latestTurnEndSeq: 9,
    planState: 'none', goalState: 'none', takeover: true, archived: false, createdAt: 'c', lastActivityAt: 'l',
  }

  it('previews the latest message and leaves other content out', () => {
    const latest = { ...(decideUpsert('s', undefined, draft({ content: { text: '  hello\n\nworld ' } })).item as TimelineItem), updatedSeq: 9, updatedAt: 'u' }
    const facts = summarize(session, latest)
    expect(facts.display).toEqual({ title: 'T', preview: 'hello world', cwd: '/w' })
    expect(facts.latestItem).toEqual({ id: 'tl_1', type: 'message', role: 'user', status: 'done', time: 'u' })
    expect(previewOf({ ...latest, type: 'tool' })).toBeNull()
  })

  it('reports turn boundaries and status changes, not item churn inside a turn', () => {
    const before = summarize({ ...session, status: 'running' }, null)
    expect(summaryChanged(before, summarize({ ...session, status: 'running', clock: { headSeq: 20, resetSeq: 0 } }, null))).toBe(false)
    expect(summaryChanged(before, summarize(session, null))).toBe(true)
  })
})
