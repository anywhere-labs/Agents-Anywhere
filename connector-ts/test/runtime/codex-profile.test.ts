import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { codexClientMessageItemId, codexModelSelectionId, codexPermissionSelectionId, codexTurnPositionItemId } from '../../src/domain/identity/index.js'
import type { JsonRecord } from '../../src/runtime/acp/client.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { CODEX, CODEX_HISTORY_RESET, codexDialect, codexPermissionCatalog, codexPlanReview } from '../../src/runtime/profiles/codex/index.js'
import { checkDefinition } from '../../src/runtime/profiles/definition.js'
import { FakeAcpAgent, tick, type Json } from '../support/fake-acp-agent.js'

const THREAD = 'native-1'

/** Shape of codex-acp's configuration options (ModelConfigOption.ts, AgentMode.ts, CollaborationModeConfig.ts). */
function codexAgent(): FakeAcpAgent {
  const agent = new FakeAcpAgent()
  agent.configOptions = [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'workspace-write', options: ['read-only', 'workspace-write', 'agent', 'agent-full-access'].map(value => ({ value, name: value })) },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-5.5', options: ['gpt-5.5', 'gpt-5.5-mini'].map(value => ({ value, name: value })) },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high'].map(value => ({ value, name: value })) },
    { id: 'collaboration_mode', name: 'Collaboration mode', category: 'collaboration_mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
  ]
  agent.peer.onRequest('_session/goal', params => {
    agent.received.push({ method: '_session/goal', params: params as Json })
    return { goal: null }
  })
  return agent
}

async function open(agent: FakeAcpAgent, selections?: Record<string, string>) {
  const dialect = codexDialect()
  const handle = new AcpRuntimeHandle({ type: 'codex', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect), permissionCatalog: codexPermissionCatalog })
  const session = await handle.open({ kind: 'new', spec: { cwd: '/w', ...(selections ? { selections } : {}) } }, { sessionId: 'aa_x1', replay: 'none' })
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { handle, session, events }
}

const codex = (turnId: string, itemType: string, clientMessageId?: string): Json => ({ codex: { turnId, itemType, ...(clientMessageId ? { clientMessageId } : {}) } })

/** One Codex turn: reasoning, an assistant message, a command, a second assistant message. */
function turnUpdates(turnId: string): Json[] {
  return [
    { sessionUpdate: 'user_message_chunk', messageId: `${turnId}-user`, content: { type: 'text', text: 'hi' }, _meta: codex(turnId, 'userMessage', 'c1') },
    { sessionUpdate: 'agent_thought_chunk', messageId: `${turnId}-r`, content: { type: 'text', text: 'thinking' }, _meta: codex(turnId, 'reasoning') },
    { sessionUpdate: 'agent_message_chunk', messageId: `${turnId}-a1`, content: { type: 'text', text: 'first' }, _meta: codex(turnId, 'agentMessage') },
    { sessionUpdate: 'tool_call', toolCallId: `${turnId}-cmd`, title: 'ls', kind: 'execute', status: 'in_progress', _meta: codex(turnId, 'commandExecution') },
    { sessionUpdate: 'tool_call_update', toolCallId: `${turnId}-cmd`, status: 'completed', _meta: codex(turnId, 'commandExecution') },
    { sessionUpdate: 'agent_message_chunk', messageId: `${turnId}-a2`, content: { type: 'text', text: 'second' }, _meta: codex(turnId, 'agentMessage') },
  ]
}

const itemIds = (events: readonly RuntimeEvent[]) => events
  .filter(e => e.type === 'message.delta' || e.type === 'tool.started' || e.type === 'tool.updated')
  .map(e => `${e.type === 'message.delta' ? e.role : 'tool'}:${(e as { itemId: string }).itemId}`)

describe('Codex definition', () => {
  it('keeps launch instructions out of the instance configuration and stays resident', () => {
    expect(() => checkDefinition(CODEX)).not.toThrow()
    expect(CODEX.idleMs).toBe(0)
    // codex-acp prints its own version on --version; the CLI version needs -V
    expect(CODEX.version).toEqual(['cli', '-V'])
  })
})

describe('Codex negotiation', () => {
  it('opts into item context and codexIpc controls, tags prompts and follows existing sessions', async () => {
    const agent = codexAgent()
    const { handle, session } = await open(agent)
    const init = agent.received.find(r => r.method === 'initialize')!.params
    expect(init.clientCapabilities).toMatchObject({ _meta: { codexItemContext: true } })
    expect(init._meta).toEqual({ codexIpc: { approvals: true, settings: true, historyReplacement: true } })
    // do not declare AIR: with AIR codex-acp switches to a different tool-report shape
    expect(JSON.stringify(init)).not.toContain('jetbrains')
    await session.prompt({ text: 'hi' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    expect(agent.received.find(r => r.method === 'session/prompt')!.params).toMatchObject({ _meta: { codexIpc: { clientMessageId: 'c1' } } })
    await handle.open({ kind: 'existing', ref: { nativeSessionId: 'thread-9', locator: '/w' } }, { sessionId: 'aa_x2', replay: 'none' })
    expect(agent.received.find(r => r.method === 'session/resume')!.params).toMatchObject({ sessionId: 'thread-9', _meta: { codexIpc: { mode: 'auto' } } })
    expect(handle.capabilities().items.find(c => c.id === 'session.goal')?.supported).toBe(true)
    await session.goal!.set('ship it')
    expect(agent.received.find(r => r.method === '_session/goal')?.params).toMatchObject({ sessionId: THREAD, action: 'set', objective: 'ship it' })
  })
})

describe('Codex timeline identity (v2 rules)', () => {
  it('numbers items per turn and lane, puts reasoning at the assistant slot and recognises AA messages', async () => {
    const agent = codexAgent()
    agent.onPrompt = async (params, a) => {
      for (const update of turnUpdates('turn-1')) a.update(String(params.sessionId), update)
      await tick()
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.prompt({ text: 'hi' }, { deliveryId: 'd', clientMessageId: 'c1' })
    await tick(20)
    const at = (position: number, lane: string) => codexTurnPositionItemId(THREAD, 'turn-1', position, lane)
    expect(itemIds(events)).toEqual([
      `reasoning:${at(0, 'reasoning')}`,
      `assistant:${at(0, 'assistant-message')}`,
      `tool:${at(0, 'tool:commandExecution')}`,
      `tool:${at(0, 'tool:commandExecution')}`,
      `assistant:${at(1, 'assistant-message')}`,
    ])
    // a message sent by AA and the userMessage Codex echoes (clientId = c1) are the same item
    expect(events.find(e => e.type === 'message.completed' && e.role === 'user')).toMatchObject({ itemId: codexClientMessageItemId(THREAD, 'c1') })
  })

  it('reads history through _codex/session/read with the same ids as live', async () => {
    const agent = codexAgent()
    agent.peer.onRequest('_codex/session/read', params => {
      agent.received.push({ method: '_codex/session/read', params: params as Json })
      return { updates: [{ sessionUpdate: 'session_info_update', title: 'T' }, ...turnUpdates('turn-1')] }
    })
    agent.onPrompt = async (params, a) => {
      for (const update of turnUpdates('turn-1')) a.update(String(params.sessionId), update)
      await tick()
      return { stopReason: 'end_turn' }
    }
    const { handle, session, events } = await open(agent)
    await session.prompt({ text: 'hi' }, { deliveryId: 'd', clientMessageId: 'c1' })
    await tick(20)
    const page = await handle.readNativeHistory({ nativeSessionId: THREAD, locator: '/w' }, { limit: 50 })
    expect(agent.received.some(r => r.method === 'session/load')).toBe(false)
    const user = page.items.find(i => i.type === 'message.delta' && i.role === 'user') as { itemId: string }
    expect(user.itemId).toBe(codexClientMessageItemId(THREAD, 'c1'))
    const historyIds = itemIds(page.items as RuntimeEvent[]).filter(id => !id.startsWith('user:'))
    expect(new Set(historyIds)).toEqual(new Set(itemIds(events)))
  })
})

describe('Codex history replacement', () => {
  it('acknowledges begin, replays the full history as replay, and resumes live after commit', async () => {
    const agent = codexAgent()
    const { session, events } = await open(agent)
    const ack = await agent.ask(CODEX_HISTORY_RESET, { sessionId: THREAD, revision: 'rev-1', phase: 'begin' })
    expect(ack).toEqual({ revision: 'rev-1', ready: true })
    for (const update of turnUpdates('turn-1')) agent.update(THREAD, update)
    agent.peer.notify(CODEX_HISTORY_RESET, { sessionId: THREAD, revision: 'rev-1', phase: 'commit' })
    await tick(10)
    const resets = events.filter((e): e is Extract<RuntimeEvent, { type: 'history.reset' }> => e.type === 'history.reset')
    expect(resets.map(e => e.phase)).toEqual(['begin', 'commit'])
    const replayed = events.slice(events.indexOf(resets[0]!) + 1, events.indexOf(resets[1]!))
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed.every(e => e.replay === true)).toBe(true)
    expect(replayed.some(e => e.type === 'turn.started')).toBe(false)
    // replace once more: positions count from the start, IDs unchanged
    const first = itemIds(replayed)
    await agent.ask(CODEX_HISTORY_RESET, { sessionId: THREAD, revision: 'rev-2', phase: 'begin' })
    const mark = events.length
    for (const update of turnUpdates('turn-1')) agent.update(THREAD, update)
    agent.peer.notify(CODEX_HISTORY_RESET, { sessionId: THREAD, revision: 'rev-2', phase: 'abort' })
    await tick(10)
    expect(itemIds(events.slice(mark))).toEqual(first)
    expect(events.at(-1)).toMatchObject({ type: 'history.reset', phase: 'abort', revision: 'rev-2' })
    // later content is live: out-of-turn content opens an autonomous turn
    agent.text(THREAD, 'live', 'm-live')
    await tick(10)
    expect(events.some(e => e.type === 'turn.started')).toBe(true)
    expect(session.nativeSessionId).toBe(THREAD)
  })

  it('ignores history resets for other sessions', async () => {
    const agent = codexAgent()
    const { events } = await open(agent)
    agent.peer.notify(CODEX_HISTORY_RESET, { sessionId: 'other', revision: 'r', phase: 'commit' })
    await tick(10)
    expect(events.some(e => e.type === 'history.reset')).toBe(false)
  })
})

describe('Codex selections and catalogs (v2 selection ids)', () => {
  it('lists models and the v2 permission catalog', async () => {
    const { handle } = await open(codexAgent())
    const catalogs = await handle.catalogs()
    const model = catalogs.models?.models?.find(m => m.id === 'gpt-5.5')
    expect(model?.selectionId).toBe(codexModelSelectionId('gpt-5.5', null))
    expect(model?.reasoningItems?.map(r => r.selectionId)).toContain(codexModelSelectionId('gpt-5.5', 'high'))
    expect(catalogs.permissions?.permissions?.map(p => [p.id, p.selectionId])).toEqual([
      ['request_approval', codexPermissionSelectionId('request_approval', { permission_mode: 'request_approval' })],
      ['auto_review', codexPermissionSelectionId('auto_review', { permission_mode: 'auto_review' })],
      ['full_access', codexPermissionSelectionId('full_access', { permission_mode: 'full_access' })],
    ])
    expect(catalogs.permissions?.permissions?.[2]?.metadata).toMatchObject({ i18n: { labelKey: 'dashboard.new.permissionModes.fullAccess.label' } })
  })

  it('has no models before a session opens, then tells the Connector once what the models are', async () => {
    const agent = codexAgent()
    const dialect = codexDialect()
    const handle = new AcpRuntimeHandle({ type: 'codex', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect), permissionCatalog: codexPermissionCatalog })
    const runtimeEvents: { type: string; catalogs?: { models?: unknown } }[] = []
    void (async () => {
      for await (const event of handle.events) runtimeEvents.push(event as (typeof runtimeEvents)[number])
    })()
    expect((await handle.catalogs()).models).toBeUndefined()
    await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_x1', replay: 'none' })
    await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_x2', replay: 'none' })
    await tick(10)
    const changed = runtimeEvents.filter(event => event.type === 'catalogs.changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]!.catalogs?.models).toEqual((await handle.catalogs()).models)
  })

  it('applies v2 model and permission selection ids at creation', async () => {
    const { session } = await open(codexAgent(), {
      model: codexModelSelectionId('gpt-5.5-mini', 'high'),
      permission: codexPermissionSelectionId('full_access', { permission_mode: 'full_access' }),
    })
    const values = Object.fromEntries(session.configOptions.map(o => [o.id, o.currentValue]))
    expect(values).toMatchObject({ model: 'gpt-5.5-mini', reasoning_effort: 'high', mode: 'agent-full-access' })
  })
})

describe('Codex planning', () => {
  const options: JsonRecord[] = [
    { optionId: 'implement_plan', kind: 'allow_once' },
    { optionId: 'revise_plan', kind: 'reject_once' },
  ]

  it('maps plan review answers to implement_plan / revise_plan', () => {
    expect(codexPlanReview({ action: 'approve' }, options)).toEqual({ optionId: 'implement_plan' })
    expect(codexPlanReview({ action: 'revise', feedback: 'smaller' }, options)).toEqual({ optionId: 'revise_plan', then: { action: 'prompt', text: 'smaller' } })
    expect(codexPlanReview({ action: 'dismiss' }, options)).toEqual({ optionId: 'revise_plan' })
  })

  it('switches collaboration_mode and opens a plan review for the completed plan', async () => {
    const agent = codexAgent()
    let answer: unknown
    agent.onPrompt = async (params, a) => {
      answer = await a.ask('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'plan-review:item-7', title: 'Implement this plan?', kind: 'switch_mode', status: 'pending', rawInput: { plan: '# Plan\n1. x' } },
        options: [{ optionId: 'implement_plan', name: 'Yes', kind: 'allow_once' }, { optionId: 'revise_plan', name: 'No', kind: 'reject_once' }],
      })
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.planning!.setMode('plan')
    expect(agent.configOptions.find(o => o.id === 'collaboration_mode')?.currentValue).toBe('plan')
    await session.prompt({ text: 'plan it' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick(10)
    const opened = events.find((e): e is Extract<RuntimeEvent, { type: 'interaction.opened' }> => e.type === 'interaction.opened')!
    expect(opened.kind).toBe('plan_review')
    expect(opened.plan?.markdown).toBe('# Plan\n1. x')
    await session.respond(opened.interactionId, { kind: 'plan_review', action: 'approve' })
    await tick(10)
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'implement_plan' } })
    await session.planning!.setMode('normal')
    expect(agent.configOptions.find(o => o.id === 'collaboration_mode')?.currentValue).toBe('default')
  })
})
