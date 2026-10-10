import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionHiddenReason, sessionVisible } from '../../src/host/dsh-runtime/visibility.js'
import { enrichAgentCallResult, toolContent } from '../../src/host/dsh-runtime/tools.js'
import type { TimelineItem } from '../../src/host/dsh-runtime/types.js'

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  id: 'item', sessionId: 'sess', type: 'tool', status: 'done', orderSeq: 0, revision: 1,
  contentHash: '', role: 'assistant', turnId: null, content: {}, source: {}, ...over,
})

test('subagent sessions are hidden from the main list but syncable', () => {
  assert.equal(sessionHiddenReason('subagent'), 'dsh_subagent')
  assert.equal(sessionHiddenReason(undefined), null)
  assert.equal(sessionHiddenReason('platform'), null)

  // Origin wins over the user-message fact: teammates are never user-visible…
  assert.equal(sessionVisible({ id: 'a', origin: 'subagent', hasUserMessage: true }, new Set()), false)
  // …and an ordinary blank session stays invisible for lacking a first message.
  assert.equal(sessionVisible({ id: 'b', hasUserMessage: false }, new Set()), false)
  assert.equal(sessionVisible({ id: 'c', hasUserMessage: true }, new Set()), true)
  assert.equal(sessionVisible({ id: 'd', origin: 'subagent', hasUserMessage: true }, new Set(['d'])), false,
    'the archive set still removes a subagent session')
})

test('team spawn results attach the member identity to the agent_call card', () => {
  const base = toolContent('spawn_teammate', { name: 'tester', description: 'runs tests', prompt: 'x' })
  assert.equal(base.kind, 'agent_call')
  assert.equal(base.action, 'spawn')
  assert.equal(base.teammateName, 'tester')

  const enriched = enrichAgentCallResult(base, { member: { id: 'sess-child', name: 'tester', description: 'runs tests', model: 'glm' } })
  assert.equal(enriched.agentId, 'sess-child')
  assert.equal(enriched.title, 'tester')
  assert.equal(enriched.model, 'glm')

  // Non-spawn tools and malformed results keep the card untouched.
  const bash = toolContent('bash', { command: 'pwd' })
  assert.equal(enrichAgentCallResult(bash, { member: { id: 'x' } }), bash)
  assert.equal(enrichAgentCallResult(base, {}), base)
  // Content-block results (the replay shape) are also understood.
  const blocks = enrichAgentCallResult(base, [{ type: 'text', text: '{"member":{"id":"sess-b"}}' }, { member: { id: 'sess-b' } }])
  assert.equal(blocks.agentId, 'sess-b')
})

test('task tools map to agent_call cards without an action', () => {
  for (const name of ['team_task_create', 'team_task_list', 'team_task_update']) {
    const content = toolContent(name, {})
    assert.equal(content.kind, 'agent_call')
    assert.equal(content.action, 'unknown')
  }
  const message = toolContent('send_message', { target: 'tester', message: 'hi' })
  assert.equal(message.kind, 'agent_call')
  assert.equal(message.action, 'send_input')
  assert.deepEqual(message.targetIds, ['tester'])
})
