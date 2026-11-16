import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import {
  claudeHistoryTurnId,
  claudeMessageItemId,
  claudeModelSelectionId,
  claudePermissionSelectionId,
  claudeStableId,
  claudeSystemItemId,
  claudeToolItemId,
} from '../../src/domain/identity/index.js'
import type { JsonRecord } from '../../src/runtime/acp/client.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { findClaudeTranscript, historyPage, readClaudeTranscript } from '../../src/runtime/companions/native-history/claude-jsonl.js'
import { CLAUDE, claudeDialect, claudeEnvironment, claudePermissionCatalog, claudePlanReview } from '../../src/runtime/profiles/claude/index.js'
import { checkDefinition } from '../../src/runtime/profiles/definition.js'
import { FakeAcpAgent, tick, type Json } from '../support/fake-acp-agent.js'

const NATIVE = 'native-1'
const scope = { sessionId: 'aa_c1', externalSessionId: NATIVE }

/** claude-agent-acp 0.107.2 的配置项形状（S2）。 */
function claudeAgent(): FakeAcpAgent {
  const agent = new FakeAcpAgent()
  agent.configOptions = [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map(value => ({ value, name: value })) },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default', options: ['default', 'opus', 'sonnet'].map(value => ({ value, name: value })) },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default', options: ['default', 'low', 'high'].map(value => ({ value, name: value })) },
  ]
  agent.initializeResult = { ...agent.initializeResult, _meta: { steering: { supported: true }, jetbrains: { air: { version: 1, capabilities: ['sessionFailure'], goal: { version: 1, controlMethod: '_session/goal', actions: ['set', 'clear'] } } } } }
  return agent
}

async function open(agent: FakeAcpAgent, selections?: Record<string, string>) {
  const dialect = claudeDialect()
  const handle = new AcpRuntimeHandle({ type: 'claude', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect), permissionCatalog: claudePermissionCatalog })
  const session = await handle.open({ kind: 'new', spec: { cwd: '/w', ...(selections ? { selections } : {}) } }, { sessionId: 'aa_c1', replay: 'none' })
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { handle, session, events }
}

describe('Claude environment', () => {
  it('keeps the user environment when not nested in Claude Code', () => {
    const env = claudeEnvironment({ PATH: '/bin', ANTHROPIC_API_KEY: 'user-key', CLAUDE_CODE_USE_BEDROCK: '1' })
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'user-key', CLAUDE_CODE_USE_BEDROCK: '1' })
  })

  it('drops the host session markers and the host-managed provider when nested', () => {
    const env = claudeEnvironment({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', AI_AGENT: 'x', ANTHROPIC_BASE_URL: 'https://host', CLAUDE_PID: '1' })
    expect(env).toEqual({ PATH: '/bin' })
    const ownProvider = claudeEnvironment({ PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k' })
    expect(ownProvider).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' })
  })

  it('injects an Anthropic model gateway and refuses other protocols', () => {
    const env = claudeEnvironment({ ANTHROPIC_API_KEY: 'user-key' }, { baseUrl: 'https://gw', authToken: 't', protocol: 'anthropic', model: 'm' })
    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' })
    expect(() => claudeEnvironment({}, { baseUrl: 'https://gw', authToken: 't', protocol: 'openai-chat' })).toThrow(/Anthropic/)
  })

  it('keeps launch instructions out of the instance configuration', () => {
    expect(() => checkDefinition(CLAUDE)).not.toThrow()
  })
})

describe('Claude timeline identity (v2 rules)', () => {
  it('uses the API message id, the tool_use id and the thinking block', async () => {
    const agent = claudeAgent()
    agent.onPrompt = async (params, a) => {
      const id = String(params.sessionId)
      a.update(id, { sessionUpdate: 'agent_thought_chunk', messageId: 'msg_01', content: { type: 'text', text: 'hmm' } })
      a.update(id, { sessionUpdate: 'tool_call', toolCallId: 'toolu_01', title: 'Bash', kind: 'execute', status: 'pending' })
      a.update(id, { sessionUpdate: 'agent_message_chunk', messageId: 'msg_02', content: { type: 'text', text: 'done' } })
      await tick()
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.prompt({ text: 'go' }, { deliveryId: 'd', clientMessageId: 'c1' })
    await tick(20)
    const byType = (type: string) => events.find(e => e.type === type) as { itemId: string; role?: string } | undefined
    expect(events.find(e => e.type === 'message.delta' && e.role === 'reasoning')).toMatchObject({ itemId: claudeSystemItemId(scope, '', 'msg_01', 0, 'thinking') })
    expect(byType('tool.started')?.itemId).toBe(claudeToolItemId(scope, 'toolu_01'))
    expect(events.find(e => e.type === 'message.delta' && e.role === 'assistant')).toMatchObject({ itemId: claudeMessageItemId(scope, 'msg_02') })
    expect(events.find(e => e.type === 'message.completed' && e.role === 'user')).toMatchObject({ itemId: claudeStableId('message', 'aa_c1', NATIVE, 'user', 'c1') })
  })
})

describe('Claude selections and catalogs (v2 selection ids)', () => {
  it('lists models and permissions with v2 selection ids', async () => {
    const { handle } = await open(claudeAgent())
    const catalogs = await handle.catalogs()
    const opus = catalogs.models?.models?.find(m => m.id === "opus")
    expect(opus?.selectionId).toBe(claudeModelSelectionId('opus'))
    expect(opus?.reasoningItems?.map(r => [r.id, r.selectionId])).toEqual([['low', claudeModelSelectionId('opus', 'low')], ['high', claudeModelSelectionId('opus', 'high')]])
    // dontAsk 不在适配器的模式里：不列出
    expect(catalogs.permissions?.permissions?.map(p => p.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    expect(catalogs.permissions?.permissions?.[1]?.selectionId).toBe(claudePermissionSelectionId('acceptEdits'))
    expect(catalogs.permissions?.permissions?.[1]?.metadata).toMatchObject({ i18n: { labelKey: 'dashboard.new.permissionModes.claude.acceptEdits.label' } })
  })

  it('applies v2 model and permission selection ids at creation', async () => {
    const agent = claudeAgent()
    const { session } = await open(agent, { model: claudeModelSelectionId('opus', 'high'), permission: claudePermissionSelectionId('acceptEdits') })
    const values = Object.fromEntries(session.configOptions.map(o => [o.id, o.currentValue]))
    expect(values).toMatchObject({ model: 'opus', effort: 'high', mode: 'acceptEdits' })
  })

  it('exposes goals only when the adapter offers the AIR goal method', async () => {
    const { handle } = await open(claudeAgent())
    expect(handle.capabilities().items.find(c => c.id === 'session.goal')).toMatchObject({ supported: true, parameters: { actions: ['set', 'clear'] } })
    const plain = claudeAgent()
    plain.initializeResult = { ...plain.initializeResult, _meta: { steering: { supported: true } } }
    const { handle: h2 } = await open(plain)
    expect(h2.capabilities().items.find(c => c.id === 'session.goal')?.supported).toBe(false)
  })
})

describe('Claude plan review', () => {
  const options: JsonRecord[] = [
    { optionId: 'exit-plan-clear-accept-edits', kind: 'allow_always' },
    { optionId: 'exit-plan-auto', kind: 'allow_always' },
    { optionId: 'exit-plan-default', kind: 'allow_once' },
    { optionId: 'reject', kind: 'reject_once' },
  ]

  it('returns to the mode before planning and never clears the context', () => {
    expect(claudePlanReview({ action: 'approve' }, options, 'auto')).toEqual({ optionId: 'exit-plan-auto' })
    expect(claudePlanReview({ action: 'approve' }, options, 'acceptEdits')).toEqual({ optionId: 'exit-plan-default' })
    expect(claudePlanReview({ action: 'approve' }, options)).toEqual({ optionId: 'exit-plan-default' })
    expect(claudePlanReview({ action: 'revise', feedback: 'smaller' }, options)).toEqual({ optionId: 'reject', then: { action: 'prompt', text: 'smaller' } })
    expect(claudePlanReview({ action: 'dismiss' }, options)).toEqual({ optionId: 'reject', then: { action: 'cancel' } })
  })

  it('sends revision feedback as a new prompt once the rejected turn ends', async () => {
    const agent = claudeAgent()
    let prompts = 0
    agent.onPrompt = async (params, a) => {
      prompts += 1
      if (prompts > 1) return { stopReason: 'end_turn' }
      const outcome = await a.peer.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'toolu_plan', title: 'ExitPlanMode', rawInput: { plan: '1. do it' } },
        options,
      }) as Json
      a.received.push({ method: 'permission-outcome', params: outcome })
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent, { permission: claudePermissionSelectionId('auto') })
    await session.prompt({ text: 'plan it' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick(10)
    const opened = events.find((e): e is Extract<RuntimeEvent, { type: 'interaction.opened' }> => e.type === 'interaction.opened')!
    expect(opened.kind).toBe('plan_review')
    expect(opened.plan?.markdown).toBe('1. do it')
    await session.respond(opened.interactionId, { kind: 'plan_review', action: 'revise', feedback: 'smaller steps' })
    await tick(20)
    expect(agent.received.find(r => r.method === 'permission-outcome')?.params).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    const second = agent.received.filter(r => r.method === 'session/prompt')[1]
    expect(second?.params.prompt).toEqual([{ type: 'text', text: 'smaller steps' }])
  })
})

describe('Claude session failures and autonomous turns', () => {
  it('maps an AIR retry warning to the v2 model retry notice', async () => {
    const agent = claudeAgent()
    agent.onPrompt = async (params, a) => {
      a.update(String(params.sessionId), { sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { version: 1, sessionFailure: { id: 'f1', revision: 1, category: 'service', severity: 'warning', title: 'Retrying (attempt 2)', actions: [] } } } } })
      a.text(String(params.sessionId), 'ok', 'msg_x')
      await tick()
      return { stopReason: 'end_turn' }
    }
    const { session, events } = await open(agent)
    await session.prompt({ text: 'go' }, { deliveryId: 'd', clientMessageId: 'c' })
    await tick(20)
    const turn = events.find((e): e is Extract<RuntimeEvent, { type: 'turn.started' }> => e.type === 'turn.started')!
    expect(events.find(e => e.type === 'notice')).toMatchObject({ kind: 'model_request_retry', level: 'warning', text: 'Retrying (attempt 2)', itemId: claudeStableId('api-retry', 'aa_c1', turn.turnId) })
  })

  it('ends a scheduled-wakeup turn at the costed usage update', async () => {
    const agent = claudeAgent()
    const { events } = await open(agent)
    agent.text(NATIVE, 'WOKE-UP', 'msg_w')
    agent.update(NATIVE, { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } })
    await tick(10)
    expect(events.map(e => e.type).filter(t => t.startsWith('turn.'))).toEqual(['turn.started', 'turn.ended'])
    expect(events.find(e => e.type === 'turn.started')).toMatchObject({ origin: 'autonomous' })
  })
})

describe('Claude native history (read-only JSONL)', () => {
  const fixture = fileURLToPath(new URL('../fixtures/claude-session.jsonl', import.meta.url))
  const dirs: string[] = []
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  it('projects the transcript with v2 history ids without touching the file', async () => {
    const native = '5b1c2d3e-0000-4000-8000-000000000001'
    const hist = { sessionId: native, externalSessionId: native }
    const before = readFileSync(fixture, 'utf8')
    const items = await readClaudeTranscript(fixture, hist)
    expect(readFileSync(fixture, 'utf8')).toBe(before)
    const turn = claudeHistoryTurnId(native, 'u-1')
    expect(items.map(i => [i.type, i.itemId])).toEqual([
      ['message.completed', claudeMessageItemId(hist, 'u-1')],
      ['message.completed', claudeSystemItemId(hist, turn, 'msg_01A', 0, 'thinking')],
      ['tool.started', claudeToolItemId(hist, 'toolu_01')],
      ['tool.updated', claudeToolItemId(hist, 'toolu_01')],
      ['message.completed', claudeMessageItemId(hist, 'msg_01B')],
    ])
    expect(items.every(i => i.turnId === turn)).toBe(true)
    expect(items.at(-1)).toMatchObject({ role: 'assistant', text: 'Two files: a.txt and b.txt.' })
    expect(items[2]).toMatchObject({ kind: 'command', status: 'done' })
    expect(historyPage(items, { limit: 2 })).toMatchObject({ olderCursor: '3' })
    expect(historyPage(items, { limit: 2, cursor: '3' }).items).toHaveLength(2)
  })

  it('finds a transcript by session id and refuses path tricks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aa-claude-projects-'))
    dirs.push(root)
    mkdirSync(join(root, '-w'))
    writeFileSync(join(root, '-w', 'abc-123.jsonl'), '')
    expect(await findClaudeTranscript('abc-123', root)).toBe(join(root, '-w', 'abc-123.jsonl'))
    expect(await findClaudeTranscript('../x', root)).toBeUndefined()
    expect(await findClaudeTranscript('missing', root)).toBeUndefined()
  })
})
