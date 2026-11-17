import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

describe('RuntimeSession port fake', () => {
  it('records calls and streams events until close', async () => {
    const session = new FakeRuntimeSession('aa_s1', 'native-1')
    session.nextPrompt = { outcome: 'unknown', error: { code: 'runtime_timeout', message: 'no ack' } }
    const acceptance = await session.prompt({ text: 'hi' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    expect(acceptance.outcome).toBe('unknown')
    session.emit({ type: 'turn.started', turnId: 't1', origin: 'user', clientMessageId: 'c1' })
    session.emit({ type: 'message.delta', itemId: 'i1', role: 'assistant', text: 'hel', turnId: 't1' })
    session.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await session.close()
    const seen: RuntimeEvent['type'][] = []
    for await (const event of session.events) seen.push(event.type)
    expect(seen).toEqual(['turn.started', 'message.delta', 'turn.ended'])
    expect(session.calls.map(call => call.method)).toEqual(['prompt', 'close'])
  })
})
