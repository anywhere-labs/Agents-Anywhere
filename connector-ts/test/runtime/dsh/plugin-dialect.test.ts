import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentInfo, JsonRecord } from '../../../src/runtime/acp/client.js'
import type { SessionContext } from '../../../src/runtime/acp/dialect.js'
import { JsonRpcError } from '../../../src/runtime/acp/jsonrpc.js'
import { dshPluginDialect, featuresOf, promptBlocks } from '../../../src/runtime/profiles/dsh/plugin/dialect.js'

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
