import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentInfo, JsonRecord } from '../../../src/runtime/acp/client.js'
import type { SessionContext } from '../../../src/runtime/acp/dialect.js'
import { JsonRpcError } from '../../../src/runtime/acp/jsonrpc.js'
import { dshPluginDialect, featuresOf, isTurnFailureCard, promptBlocks } from '../../../src/runtime/profiles/dsh/plugin/dialect.js'

const info = (features: JsonRecord = {}): AgentInfo => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
  agentInfo: { name: 'dsh' }, authMethods: [], meta: { dsh: { features } } })
const context = (sessionId: string, nativeSessionId = 'native-1', epoch = 'e1'): SessionContext => ({ sessionId, nativeSessionId, epoch, info: info() })
const item = `dsh_${'a'.repeat(64)}`
const chunk = (dsh: JsonRecord, text = 'hi', kind = 'agent_message_chunk'): JsonRecord =>
  ({ sessionUpdate: kind, content: { type: 'text', text }, _meta: { dsh } })

describe('the DSH plugin dialect (contracts/dsh-bridge/3.0)', () => {
  test('features and capabilities follow the plugin initialize answer', () => {
    expect(featuresOf(info({ steer: true, questions: true })).steer).toBe(true)
    const caps = new Map(dshPluginDialect().capabilities!(info({ steer: true, planning: true, attachments: true })).map(cap => [cap.id, cap]))
    expect(caps.get('session.steer')?.supported).toBe(true)
    expect(caps.get('session.plan_review')?.supported).toBe(true)
    expect(caps.get('runtime.attachment')).toMatchObject({ supported: true, parameters: { image: true, files: false } })
    expect(new Map(dshPluginDialect().capabilities!(info()).map(cap => [cap.id, cap.supported])).get('runtime.attachment')).toBe(false)
  })

  test('user items are keyed by the native session, so history, replay and prompt agree', () => {
    const dialect = dshPluginDialect()
    const live = dialect.identity!(context('sess_a'))
    const history = dialect.identity!(context('history:native-1', 'native-1', 'history'))
    const echoed = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' }, _meta: { dsh: { requestId: 'cm-1' } } }
    expect(live.itemFor(echoed)).toBe(live.userItemId('cm-1'))
    expect(history.itemFor(echoed)).toBe(live.userItemId('cm-1'))
    const typed = { sessionUpdate: 'user_message_chunk', messageId: 'm-7', content: { type: 'text', text: 'x' }, _meta: { dsh: {} } }
    expect(history.itemFor(typed)).toBe(live.itemFor(typed))
    expect(dialect.identity!(context('sess_a', 'native-2')).userItemId('cm-1')).not.toBe(live.userItemId('cm-1'))
    expect(live.itemFor(chunk({ itemId: item }))).toBe(item)
  })

  test('a stream attempt fills the item; a retry starts it over; the committed message replaces it', () => {
    const dialect = dshPluginDialect()
    const ctx = context('s')
    expect(dialect.translateUpdate!(chunk({ itemId: item, transient: true, attemptId: 'a1' }, '你'), ctx, {})).toEqual([{ type: 'message.delta', itemId: item, role: 'assistant', text: '你' }])
    expect(dialect.translateUpdate!(chunk({ itemId: item, transient: true, attemptId: 'a2' }, '好'), ctx, {})).toEqual([
      { type: 'message.completed', itemId: item, role: 'assistant', text: '' }, { type: 'message.delta', itemId: item, role: 'assistant', text: '好' }])
    expect(dialect.translateUpdate!(chunk({ itemId: item, committed: true }, '你好', 'agent_thought_chunk'), ctx, {})).toEqual([{ type: 'message.completed', itemId: item, role: 'reasoning', text: '你好' }])
    expect(dialect.translateUpdate!(chunk({ abandoned: true }), ctx, {})).toEqual([])
  })

  test('writer changes and turn events on session_info_update', () => {
    const dialect = dshPluginDialect()
    const info = (dsh: JsonRecord) => ({ sessionUpdate: 'session_info_update', _meta: { dsh } })
    expect(dialect.translateUpdate!(info({ writer: 'external' }), context('s'), {})).toEqual([{ type: 'writer.changed', writer: { holder: 'external', by: 'dsh' } }])
    expect(dialect.translateUpdate!(info({ writer: 'host' }), context('s'), {})).toEqual([{ type: 'writer.changed', writer: { holder: 'self' } }])
    expect(dialect.translateUpdate!(info({ turnEvent: { kind: 'started' } }), context('s'), {})).toEqual([])
    expect(dialect.translateUpdate!(info({}), context('s'), {})).toBeUndefined()
  })

  test('a failed turn event opens a card that offers "continue" only when the plugin and DSH both can; replays open nothing', () => {
    const dialect = dshPluginDialect()
    const ended = (extra: JsonRecord = {}) => ({ sessionUpdate: 'session_info_update', _meta: { dsh: { turnEvent: { sessionId: 'native-1', phase: 'ended', turn: 3, seq: 42,
      requestIds: [], stopReason: 'end_turn', reason: { kind: 'error', message: '429 rate limited' }, continuable: true, ...extra } } } })
    const live = { ...context('s'), info: info({ continue: true }) }
    expect(dialect.translateUpdate!(ended(), live, { turnId: 't1' })).toEqual([{
      type: 'interaction.opened', turnId: 't1', interactionId: 'dsh_turn_failed_42', kind: 'execution_error', title: 'DSH 本轮执行失败', body: '429 rate limited',
      options: [{ id: 'continue', label: '继续', kind: 'other' }],
      context: { kind: 'execution_error', outcome: 'failed', turnEndReason: 'error', error: { message: '429 rate limited' } },
      metadata: { source: 'dsh.turn.failed', turnEndSeq: 42 },
    }])
    // Without the plugin feature, or when DSH would not continue, the card has no action.
    expect(dialect.translateUpdate!(ended(), context('s'), {})).toMatchObject([{ interactionId: 'dsh_turn_failed_42' }])
    expect((dialect.translateUpdate!(ended(), context('s'), {})![0] as { options?: unknown }).options).toBeUndefined()
    expect((dialect.translateUpdate!(ended({ continuable: false }), live, {})![0] as { options?: unknown }).options).toBeUndefined()
    expect((dialect.translateUpdate!(ended({ reason: { kind: 'error' } }), live, {})![0] as { body?: string }).body).toBe('本轮执行失败，没有生成回复。')
    expect(dialect.translateUpdate!(ended(), live, { replay: true })).toEqual([])
    expect(dialect.translateUpdate!(ended({ reason: { kind: 'completed' } }), live, {})).toEqual([])
    expect(isTurnFailureCard('dsh_turn_failed_42')).toBe(true)
    expect(isTurnFailureCard('dsh_turn_failed_042')).toBe(false)
    expect(isTurnFailureCard('interaction_1')).toBe(false)
  })

  test('"continue" calls _dsh/session/continue; unavailable closes the card, an error answer keeps it, a lost answer throws', async () => {
    const dialect = dshPluginDialect()
    const calls: { method: string, params: JsonRecord }[] = []
    const emitted: unknown[] = []
    const card = (answer: (params: JsonRecord) => unknown) => ({ nativeSessionId: 'native-1', emit: (event: unknown) => emitted.push(event),
      request: async (method: string, params: JsonRecord) => { calls.push({ method, params }); return answer(params) } })
    const go = { kind: 'option' as const, optionId: 'continue' }
    expect(dialect.respondCard!('interaction_1', go, card(() => ({})))).toBeUndefined()
    expect(await dialect.respondCard!('dsh_turn_failed_42', go, card(() => ({ outcome: 'accepted' })))).toBeUndefined()
    expect(calls).toEqual([{ method: '_dsh/session/continue', params: { sessionId: 'native-1', turnEndSeq: 42 } }])
    expect(emitted).toEqual([{ type: 'interaction.resolved', interactionId: 'dsh_turn_failed_42', resolution: 'answered', answeredBy: 'self' }])
    expect(await dialect.respondCard!('dsh_turn_failed_42', go, card(() => ({ outcome: 'unavailable' }))))
      .toEqual({ refused: { code: 'dsh_continue_unavailable', message: '这一轮已无法继续生成，请重新发送消息。' }, closes: true })
    expect(await dialect.respondCard!('dsh_turn_failed_42', go, card(() => { throw new JsonRpcError(-32000, 'gone', { code: 'session_not_found' }) })))
      .toEqual({ refused: { code: 'session_not_found', message: 'gone' }, closes: false })
    await expect(dialect.respondCard!('dsh_turn_failed_42', go, card(() => { throw new Error('connection closed') }))).rejects.toThrow('connection closed')
    expect(await dialect.respondCard!('dsh_turn_failed_42', { kind: 'option', optionId: 'other' }, card(() => ({}))))
      .toMatchObject({ refused: { code: 'invalid_argument' }, closes: false })
  })

  test('new sessions need AA\'s native ID; prompts carry the request ID; errors map to port codes', () => {
    const dialect = dshPluginDialect()
    expect(() => dialect.newSessionParams!({ cwd: '/w' })).toThrow(JsonRpcError)
    expect(dialect.newSessionParams!({ cwd: '/w', preferredNativeSessionId: 'aa_1' })).toEqual({ _meta: { dsh: { sessionId: 'aa_1' } } })
    expect(dialect.promptParams!({ deliveryId: 'd', clientMessageId: 'cm' })).toEqual({ _meta: { dsh: { requestId: 'cm', delivery: 'turn' } } })
    expect(dialect.classifyError!(new JsonRpcError(-32000, 'held', { code: 'writer_held' }))).toEqual({ code: 'writer_held', message: 'held', retryable: true })
    expect(dialect.classifyError!(new JsonRpcError(-32000, 'x', { code: 'other' }))).toBeUndefined()
    expect(dialect.interactionKind!('session/request_permission', { _meta: { dsh: { planningReview: {} } } })).toBe('plan_review')
  })

  test('prompt blocks: images inline, other files as uploads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-dsh-blocks-'))
    try {
      writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3]))
      writeFileSync(join(dir, 'b.txt'), 'hello')
      const blocks = promptBlocks({ text: 't', attachments: [
        { kind: 'file', path: join(dir, 'a.png'), mimeType: 'image/png' },
        { kind: 'file', path: join(dir, 'b.txt'), mimeType: 'text/plain' },
      ] })
      expect(blocks[0]).toEqual({ type: 'text', text: 't' })
      expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') })
      expect(blocks[2]).toMatchObject({ type: 'resource_link', name: 'b.txt', _meta: { dsh: { upload: { path: join(dir, 'b.txt'), size: 5 } } } })
      expect(() => promptBlocks({ text: '', attachments: [{ kind: 'inline', mimeType: 'text/plain', data: 'x' }] })).toThrow(JsonRpcError)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
