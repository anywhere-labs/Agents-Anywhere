import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { AcpProjectionIdentity, acpFingerprint } from '../../src/domain/identity/index.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import type { AcpRuntimeSession } from '../../src/runtime/acp/session.js'
import { FakeAcpAgent, tick } from '../support/fake-acp-agent.js'

const dialect: AcpDialect = {
  runtime: 'acp:fake',
  clientCapabilities: () => ({ elicitation: { form: {} } }),
  capabilities: () => [{ id: 'session.send_message', supported: true }],
  steer: 'extension',
  planMode: options => (options.some(o => o.id === 'mode') ? { optionId: 'mode', planValue: 'plan' } : undefined),
}

async function open(agent: FakeAcpAgent, d: AcpDialect = dialect): Promise<{ handle: AcpRuntimeHandle; session: AcpRuntimeSession; events: RuntimeEvent[] }> {
  const handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'i1', dialect: d, connect: peerConnection(agent.clientPeer, d) })
  const session = await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_s1', replay: 'none' })
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { handle, session, events }
}

describe('AcpRuntimeSession', () => {
  it('accepts on the first assistant update and ends the turn with the stop reason', async () => {
    const agent = new FakeAcpAgent()
    agent.onPrompt = async (params, a) => {
      const sessionId = String(params.sessionId)
      await tick()
      a.text(sessionId, 'Hel')
      a.text(sessionId, 'lo')
      await tick()
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    const acceptance = await session.prompt({ text: 'hi' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    expect(acceptance.outcome).toBe('accepted')
    await tick(20)
    const types = events.map(e => e.type)
    expect(types).toEqual(['turn.started', 'message.completed', 'message.delta', 'message.delta', 'turn.ended'])
    const deltas = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta')
    expect(deltas.map(d => d.text).join('')).toBe('Hello')
    // both deltas of one message land on the same item; IDs follow the generic ACP rule (session ID + connection epoch + sequence)
    expect(deltas[0]!.itemId).toBe(deltas[1]!.itemId)
    const user = events[1] as Extract<RuntimeEvent, { type: 'message.completed' }>
    expect(user.itemId).toBe(acpFingerprint(['aa_s1', 'user_message_chunk', 'c1']))
    const prompt = agent.received.find(r => r.method === 'session/prompt')!
    expect(prompt.params).toMatchObject({ sessionId: 'native-1', prompt: [{ type: 'text', text: 'hi' }] })
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
  })

  it('uses the v2 projection identity for messages', async () => {
    const identity = new AcpProjectionIdentity('aa_s1', 'epoch')
    const id = identity.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } })
    expect(id).toBe(acpFingerprint(['aa_s1', 'epoch', 'agent_message_chunk', 1]))
  })

  it('rejects on a definite error and reports unknown when the agent disconnects', async () => {
    const agent = new FakeAcpAgent()
    agent.onPrompt = async () => {
      throw Object.assign(new Error('bad prompt'), { code: -32602 })
    }
    const { session } = await open(agent)
    const rejected = await session.prompt({ text: 'x' }, { deliveryId: 'd', clientMessageId: 'c' })
    expect(rejected.outcome).toBe('rejected')

    const agent2 = new FakeAcpAgent()
    agent2.onPrompt = () => new Promise(() => undefined)
    const opened = await open(agent2)
    const pending = opened.session.prompt({ text: 'x' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick()
    agent2.peer.close('agent crashed')
    const unknown = await pending
    expect(unknown.outcome).toBe('unknown')
  })

  it('opens an approval, answers it, and expires pending ones on cancel', async () => {
    const agent = new FakeAcpAgent()
    let answer: unknown
    agent.onPrompt = async (params, a) => {
      const sessionId = String(params.sessionId)
      a.update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write x', kind: 'edit', status: 'pending' })
      answer = await a.ask('session/request_permission', {
        sessionId, toolCall: { toolCallId: 't1', title: 'Write x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      })
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.prompt({ text: 'write' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick(10)
    const opened = events.find((e): e is Extract<RuntimeEvent, { type: 'interaction.opened' }> => e.type === 'interaction.opened')!
    expect(opened.options?.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])
    const tool = events.find(e => e.type === 'tool.started') as Extract<RuntimeEvent, { type: 'tool.started' }>
    expect(opened.itemId).toBe(tool.itemId)
    await session.respond(opened.interactionId, { kind: 'option', optionId: 'allow' })
    await tick(10)
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(events.some(e => e.type === 'interaction.resolved')).toBe(true)

    // cancel: the pending approval resolves as cancelled
    agent.onPrompt = async (params, a) => {
      answer = await a.ask('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 't2' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] })
      return { stopReason: 'cancelled' }
    }
    await session.prompt({ text: 'again' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    await tick(10)
    await session.cancel()
    await tick(10)
    expect(answer).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(agent.cancelled).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'cancelled' })
  })

  it('keeps a pending approval when the answer names an option that was not offered', async () => {
    const agent = new FakeAcpAgent()
    let answer: unknown
    agent.onPrompt = async (params, a) => {
      answer = await a.ask('session/request_permission', {
        sessionId: params.sessionId, toolCall: { toolCallId: 't1', title: 'Write x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      })
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.prompt({ text: 'write' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick(10)
    const opened = events.find((e): e is Extract<RuntimeEvent, { type: 'interaction.opened' }> => e.type === 'interaction.opened')!
    await expect(session.respond(opened.interactionId, { kind: 'option', optionId: 'bogus' })).rejects.toThrow(/not offered/)
    await tick(10)
    expect(answer).toBeUndefined()
    expect(events.some(e => e.type === 'interaction.resolved')).toBe(false)
    expect(session.busy).toBe(true)
    // the interaction is still there: the user can answer again, the Agent gets the answer and the turn ends normally.
    await session.respond(opened.interactionId, { kind: 'option', optionId: 'allow' })
    await tick(10)
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
  })

  it('rejects a prompt whose input the dialect cannot convert, without sending it or taking the turn', async () => {
    const agent = new FakeAcpAgent()
    agent.onPrompt = async () => ({ stopReason: 'end_turn' })
    const failing: AcpDialect = {
      ...dialect,
      promptBlocks: input => {
        if (input.attachments?.length) throw Object.assign(new Error('ENOENT: no such file /w/missing.png'), { code: 'ENOENT' })
        return [{ type: 'text', text: input.text }]
      },
    }
    const { session, events } = await open(agent, failing)
    const rejected = await session.prompt({ text: 'look', attachments: [{ kind: 'file', path: '/w/missing.png', mimeType: 'image/png' }] }, { deliveryId: 'd1', clientMessageId: 'c1' })
    expect(rejected).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_argument', message: expect.stringContaining('ENOENT') } })
    expect(session.busy).toBe(false)
    expect(events.some(e => e.type === 'turn.started')).toBe(false)
    const next = await session.prompt({ text: 'again' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    expect(next.outcome).toBe('accepted')
    expect(agent.received.filter(r => r.method === 'session/prompt')).toHaveLength(1)
  })

  it('starts a new assistant item in each turn even though the user echo is filtered (v2 Projection.finish)', async () => {
    const agent = new FakeAcpAgent()
    agent.onPrompt = async (params, a) => {
      const sessionId = String(params.sessionId)
      a.update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })
      a.text(sessionId, `reply ${agent.received.filter(r => r.method === 'session/prompt').length}`)
      await tick()
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.prompt({ text: 'one' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    await tick(20)
    await session.prompt({ text: 'two' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    await tick(20)
    const assistant = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.role === 'assistant')
    expect(assistant.map(e => e.text)).toEqual(['reply 1', 'reply 2'])
    expect(assistant[0]!.itemId).not.toBe(assistant[1]!.itemId)
    expect(events.filter(e => e.type === 'message.delta' && e.role === 'user')).toHaveLength(0)
  })

  it('AcpProjectionIdentity.finish ends the current message, like v2 Projection.finish', () => {
    const identity = new AcpProjectionIdentity('aa_s1', 'epoch')
    const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }
    const first = identity.apply(chunk)
    expect(identity.apply(chunk)).toBe(first)
    identity.finish()
    expect(identity.apply(chunk)).toBe(acpFingerprint(['aa_s1', 'epoch', 'agent_message_chunk', 2]))
  })

  it('maps plan review answers to ACP options (revise steers the feedback)', async () => {
    const agent = new FakeAcpAgent()
    let answer: unknown
    agent.onPrompt = async (params, a) => {
      answer = await a.ask('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'p1', title: 'ExitPlanMode', rawInput: { plan: '# Plan\n1. do it' } },
        options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No, keep planning', kind: 'reject_once' }],
      })
      await tick(80)
      return { stopReason: 'end_turn' }
    }
    const planDialect: AcpDialect = { ...dialect, interactionKind: (_m, params) => (JSON.stringify(params).includes('ExitPlanMode') ? 'plan_review' : undefined) }
    const { session, events } = await open(agent, planDialect)
    await session.prompt({ text: 'plan' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick(10)
    const opened = events.find((e): e is Extract<RuntimeEvent, { type: 'interaction.opened' }> => e.type === 'interaction.opened')!
    expect(opened.kind).toBe('plan_review')
    expect(opened.plan?.markdown).toBe('# Plan\n1. do it')
    await session.respond(opened.interactionId, { kind: 'plan_review', action: 'revise', feedback: 'name it y.txt' })
    await tick(100)
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    const steer = agent.received.find(r => r.method === '_session/steering')
    expect(steer?.params).toMatchObject({ prompt: [{ type: 'text', text: 'name it y.txt' }] })
  })

  it('configures options, steers, and tracks plan mode', async () => {
    const agent = new FakeAcpAgent()
    agent.onPrompt = async (params, a) => {
      a.text(String(params.sessionId), 'working')
      await tick(30)
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    const result = await session.configure({ optionId: 'model', value: 'm2' })
    expect(result.options.find(o => o.id === 'model')?.currentValue).toBe('m2')
    await expect(session.configure({ optionId: 'model', value: 'nope' })).rejects.toMatchObject({ code: -32602 })
    await session.planning!.setMode('plan')
    expect(events.filter(e => e.type === 'planning.mode_changed').at(-1)).toMatchObject({ mode: 'plan' })
    await session.planning!.setMode('normal')
    expect(agent.configOptions.find(o => o.id === 'mode')?.currentValue).toBe('default')
    expect(await session.steer!({ text: 'more' }, { deliveryId: 'd', clientMessageId: 'c' })).toEqual({ outcome: 'prompt_required' })
    await session.prompt({ text: 'go' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    const steered = await session.steer!({ text: 'and this' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    expect(steered.outcome).toBe('injected')
  })

  it('starts an autonomous turn for content outside a prompt and ends it when quiet', async () => {
    const agent = new FakeAcpAgent()
    const handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect) })
    const session = await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_s2', replay: 'none' })
    ;(session as unknown as { autonomousQuietMs: number }).autonomousQuietMs = 20
    const events: RuntimeEvent[] = []
    void (async () => {
      for await (const event of session.events) events.push(event)
    })()
    agent.text('native-1', 'woke up')
    await tick(60)
    expect(events.map(e => e.type)).toEqual(['turn.started', 'message.delta', 'turn.ended'])
    expect(events[0]).toMatchObject({ origin: 'autonomous' })
  })

  it('lists native sessions, replays history on open and reads history read-only', async () => {
    const agent = new FakeAcpAgent()
    agent.history = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } },
    ]
    const handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect) })
    expect((await handle.listNativeSessions()).sessions).toEqual([{ nativeSessionId: 'native-old', title: 'Old', cwd: '/w' }])
    const page = await handle.readNativeHistory({ nativeSessionId: 'native-old', locator: '/w' }, { limit: 10 })
    expect(page.items.map(i => (i.type === 'message.delta' ? `${i.role}:${i.text}` : i.type))).toEqual(['user:old question', 'assistant:old answer'])
    expect(agent.received.filter(r => r.method === 'session/close')).toHaveLength(1)
    const session = await handle.open({ kind: 'existing', ref: { nativeSessionId: 'native-old', locator: '/w' } }, { sessionId: 'aa_old', replay: 'full' })
    const events: RuntimeEvent[] = []
    void (async () => {
      for await (const event of session.events) events.push(event)
    })()
    await tick()
    expect(events.every(e => e.replay === true)).toBe(true)
    expect(events).toHaveLength(2)
    const resumed = await handle.open({ kind: 'existing', ref: { nativeSessionId: 'native-old' } }, { sessionId: 'aa_old2', replay: 'none' })
    expect(resumed.nativeSessionId).toBe('native-old')
    expect(agent.received.some(r => r.method === 'session/resume')).toBe(true)
  })

  it('opens an existing session and reads its history in the session directory, not the process directory', async () => {
    const agent = new FakeAcpAgent()
    const handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect) })
    await handle.readNativeHistory({ nativeSessionId: 'native-old', cwd: '/w/project' }, { limit: 10 })
    await handle.open({ kind: 'existing', ref: { nativeSessionId: 'native-old', cwd: '/w/project' } }, { sessionId: 'aa_old', replay: 'none' })
    const opened = agent.received.filter(r => r.method === 'session/load' || r.method === 'session/resume')
    expect(opened.map(r => (r.params as { cwd?: string }).cwd)).toEqual(['/w/project', '/w/project'])
  })
})
