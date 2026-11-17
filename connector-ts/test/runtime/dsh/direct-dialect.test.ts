import { describe, expect, test } from 'vitest'

import type { SessionContext } from '../../../src/runtime/acp/dialect.js'
import { dshDirectDialect } from '../../../src/runtime/profiles/dsh/direct/dialect.js'

const context = (sessionId: string): SessionContext => ({ sessionId, nativeSessionId: `native-${sessionId}`, epoch: 'ep1', info: { meta: {} } as never })
const chunk = (text: string, kind = 'agent_message_chunk', messageId?: string) => ({ sessionUpdate: kind, content: { type: 'text', text }, ...(messageId !== undefined ? { messageId } : {}) })

describe('DSH direct dialect item ids', () => {
  test('every committed message is its own item, also back to back', () => {
    const dialect = dshDirectDialect()
    const ctx = context('sess_1')
    const ids = ['one', 'two', 'three'].map(text => dialect.translateUpdate!(chunk(text), ctx, {})![0]!)
    expect(ids.map(event => (event as { text: string }).text)).toEqual(['one', 'two', 'three'])
    expect(new Set(ids.map(event => (event as { itemId: string }).itemId)).size).toBe(3)
  })

  test('sessions number their items independently, and a DSH messageId keeps the same item', () => {
    const dialect = dshDirectDialect()
    const a = dialect.translateUpdate!(chunk('a'), context('sess_a'), {})![0] as { itemId: string }
    const b = dialect.translateUpdate!(chunk('b'), context('sess_b'), {})![0] as { itemId: string }
    expect(a.itemId).not.toBe(b.itemId)
    const ctx = context('sess_m')
    const first = dialect.translateUpdate!(chunk('x', 'agent_message_chunk', 'm1'), ctx, {})![0] as { itemId: string }
    const again = dialect.translateUpdate!(chunk('x2', 'agent_message_chunk', 'm1'), ctx, {})![0] as { itemId: string }
    expect(again.itemId).toBe(first.itemId)
  })
})
