import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { FakeAcpAgent, tick } from '../support/fake-acp-agent.js'

// The ACP-core part of 04 §5.6 (route switches hand over the write lock): switch only between turns, start no new turn during the handover,
// and an accepted turn that disconnects midway has an unknown outcome (no resend).
const dialect: AcpDialect = {
  runtime: 'acp:fake',
  clientCapabilities: () => ({}),
  capabilities: () => [{ id: 'session.send_message', supported: true }],
  steer: 'none',
}

function setup() {
  const agent = new FakeAcpAgent()
  let finish: () => void = () => undefined
  agent.onPrompt = async (params, a) => {
    a.text(String(params.sessionId), 'working')
    await new Promise<void>(resolve => { finish = resolve })
    return { stopReason: 'end_turn' }
  }
  const handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect) })
  return { agent, handle, finish: () => finish() }
}

async function open(handle: AcpRuntimeHandle, id: string) {
  const session = await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: id, replay: 'none' })
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { session, events }
}

describe('ACP route handoff', () => {
  it('closes idle sessions at once and running ones after their turn, then refuses new work', async () => {
    const { agent, handle, finish } = setup()
    const idle = await open(handle, 'aa_idle')
    const running = await open(handle, 'aa_run')
    expect((await running.session.prompt({ text: 'go' }, { deliveryId: 'd', clientMessageId: 'c' })).outcome).toBe('accepted')
    const released: string[] = []
    const drained = handle.drain(session => released.push(session.sessionId))
    await tick(10)
    // an idle session closes at once; a running session keeps running but takes no new messages
    expect(released).toEqual(['aa_idle'])
    expect(agent.received.filter(r => r.method === 'session/close').map(r => r.params.sessionId)).toEqual([idle.session.nativeSessionId])
    expect(await running.session.prompt({ text: 'more' }, { deliveryId: 'd2', clientMessageId: 'c2' })).toMatchObject({ outcome: 'rejected', error: { code: 'session_busy' } })
    await expect(handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_new', replay: 'none' })).rejects.toMatchObject({ error: { code: 'runtime_route_switching', retryable: true } })
    finish()
    await drained
    expect(released).toEqual(['aa_idle', 'aa_run'])
    expect(running.events.find(e => e.type === 'turn.ended')).toMatchObject({ reason: 'end_turn' })
    expect(agent.received.filter(r => r.method === 'session/close')).toHaveLength(2)
  })

  it('refuses a prompt that arrives while the session waits to be released', async () => {
    const { handle, finish } = setup()
    const { session } = await open(handle, 'aa_1')
    await session.prompt({ text: 'go' }, { deliveryId: 'd', clientMessageId: 'c' })
    const releasing = session.releaseBetweenTurns()
    finish()
    await releasing
    expect(await session.prompt({ text: 'late' }, { deliveryId: 'd2', clientMessageId: 'c2' })).toMatchObject({ outcome: 'rejected' })
  })

  it('reports an accepted turn cut off by a disconnect as an unknown outcome', async () => {
    const { agent, handle } = setup()
    const { session, events } = await open(handle, 'aa_1')
    expect((await session.prompt({ text: 'go' }, { deliveryId: 'd', clientMessageId: 'c' })).outcome).toBe('accepted')
    agent.peer.close('host quit')
    await tick(10)
    expect(events.find(e => e.type === 'turn.ended')).toMatchObject({ reason: 'failed', error: { code: 'runtime_disconnected', retryable: false, details: { outcome: 'unknown' } } })
    expect(events.at(-1)).toMatchObject({ type: 'session.lost' })
  })
})
