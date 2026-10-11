import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter, initialSelections } from '../fixtures/agent-runtime.js'
import { nativeSessionId } from '../../src/host/dsh-runtime/identity.js'

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 400; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

/** Inbox targets recorded by the durable splice, keyed by message text. */
function spliceTargets(events: readonly { type: string, data: unknown }[]): Map<string, string> {
  const targets = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data as { target?: string, inserted?: { content?: { type: string, text?: string }[] }[] }
    for (const message of data.inserted ?? []) {
      const text = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')
      if (text) targets.set(text, data.target ?? '')
    }
  }
  return targets
}

/**
 * `queue` and `steer` are the two ways a user can add a requirement while the
 * Agent is already working: queue opens a later turn, steer splices into the
 * turn that is running. The durable inbox splice records which target the
 * bridge chose, and the next model request proves the Agent saw the text.
 */
test('steering splices into the running turn while queueing opens a later turn', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-steer-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const id = SessionId(nativeSessionId('test', 'sess-steer'))
  try {
    await native.send(id, '第一条', 'client-1', home, true, initialSelections, 'standard')
    await until(() => !!adapter.release, 'model started')

    // The first turn is streaming: steer must reach the Agent without waiting
    // for it to finish.
    await native.send(id, '插话：改用另一种方案', 'client-steer', undefined, false, {}, undefined,
      new AbortController().signal, [], undefined, 'steer')
    assert.ok(adapter.release, 'the model is still streaming when the steer is admitted')

    adapter.release!()
    await until(() => adapter.requests.length === 2 && !!adapter.release, 'steered step ran')
    const steered = JSON.stringify(adapter.requests[1]!.messages)
    assert.ok(steered.includes('插话：改用另一种方案'), 'the running turn sees the steered requirement')
    adapter.release!()
    await fixture.ctx.agents.get(id)!.whenIdle()

    const log = await native.read(id)
    const targets = spliceTargets(log.events)
    assert.equal(targets.get('插话：改用另一种方案'), 'next-step', 'steer splices into the running turn')
    const users = log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.equal(users.length, 2, 'both requirements are durable user messages')

    // A queued message instead lands in the next turn's inbox.
    await native.send(id, '排队：下一轮再处理', 'client-queued')
    await until(() => adapter.requests.length === 3 && !!adapter.release, 'queued turn ran')
    adapter.release!()
    await fixture.ctx.agents.get(id)!.whenIdle()
    const queued = await native.read(id)
    assert.equal(spliceTargets(queued.events).get('排队：下一轮再处理'), 'next-turn', 'queueing waits for a later turn')
  } finally {
    await fixture.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
