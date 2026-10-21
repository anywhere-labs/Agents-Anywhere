import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { InteractionStream } from '../../src/host/dsh-runtime/interaction-stream.js'

test('repeated connection failures do not publish unchanged capabilities; recovery and disconnect do', { timeout: 10_000 }, async () => {
  const ctx = new Context()
  const owner = { id: 'owner', ctx, signal: new AbortController().signal, dispose() {} }
  let attempts = 0, changes = 0, recovered = false
  const connected = new Promise<void>(resolve => {
    ctx.provide('connection', { browserPeer: owner } as unknown as Context['connection'])
    ctx.provide('userQuestions', {} as Context['userQuestions'])
    ctx.provide('typertGateway', { wireStream: {
      async open(_endpoint: unknown, _payload: unknown, _uplink: unknown, peer: unknown, signal: AbortSignal) {
        attempts++
        assert.equal(peer, owner)
        if (!recovered) throw new Error('connection temporarily unavailable')
        return (async function* () {
          yield { type: 'ready', clientId: 'recovered' }
          resolve()
          await delay(60_000, undefined, { signal })
        })()
      },
    } } as unknown as Context['typertGateway'])
  })
  const stream = new InteractionStream(ctx, async () => {}, () => { changes++ })
  try {
    for (let n = 0; n < 200 && attempts < 3; n++) await delay(10)
    assert.ok(attempts >= 3, 'several reconnect attempts occurred')
    assert.equal(changes, 0, 'an unavailable consumer must not flood runtime/session capability updates')
    recovered = true
    await connected
    assert.equal(stream.available, true)
    assert.equal(changes, 1)
    await stream.close()
    assert.equal(stream.available, false)
    assert.equal(changes, 2, 'a real loss of capability is still published')
  } finally { await stream.close(); await ctx.fiber.dispose() }
})
