import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { createProjection, projectHistory } from '../../src/host/dsh-runtime/history.js'

test('normalized history and live items are valid UTF-8 on the wire', async () => {
  const text = '中文 👇 \udc47 \ud83d end'
  const snapshot = { session: { id: 'unicode-history' }, events: [
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'run_code', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: {
      toolCallId: 'call', content: [{ type: 'text', text }], isError: false,
    } } },
  ].map((event, seq) => ({ ...event, seq, time: 1000 + seq })) } as SessionLogSnapshot
  const original = JSON.stringify(snapshot)
  const projection = createProjection('unicode-history', 'platform')
  const live = snapshot.events.flatMap(event => {
    projection.apply(event)
    return projection.drain().items
  })
  const cold = projectHistory(snapshot, 'platform')
  assert.deepEqual(projection.snapshot(), cold)
  assert.equal(JSON.stringify(snapshot), original)
  // Lone surrogates become U+FFFD so every item is valid UTF-8 on the wire, and nothing else changes.
  const last = [...live, ...cold].at(-1)!
  assert.equal((last.content as { output: string }).output, '中文 👇 \ufffd \ufffd end')
  assert.deepEqual((last.content as { result: unknown }).result, [{ type: 'text', text: '中文 👇 \ufffd \ufffd end' }])
  for (const item of [...live, ...cold]) {
    const wire = JSON.stringify(item)
    assert.equal(Buffer.from(wire, 'utf8').toString('utf8'), wire, 'the serialized item survives a UTF-8 round trip')
  }
})
