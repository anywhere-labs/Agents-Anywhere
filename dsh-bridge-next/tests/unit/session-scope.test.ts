import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_CONNECTOR_SETTINGS, type SessionSyncScope } from '../../src/contracts/connector.js'
import { validateConnectorSettings } from '../../src/host/connector/settings.js'
import { isSessionMessage, sessionVisible } from '../../src/host/dsh-runtime/visibility.js'

const message = (kind: string): SessionEvent => ({ type: 'user/message', data: { source: { kind } } }) as unknown as SessionEvent
const human = message('user')
const injected = message('plugin:@michengai/dsh-pua/runtime')

test('the human scope only counts messages a person typed', () => {
  assert.equal(isSessionMessage(human, 'human'), true)
  assert.equal(isSessionMessage(injected, 'human'), false)
  assert.equal(isSessionMessage({ type: 'assistant/message', data: {} } as unknown as SessionEvent, 'human'), false)
})

test('the all scope also counts plugin and runtime context messages', () => {
  assert.equal(isSessionMessage(human, 'all'), true)
  assert.equal(isSessionMessage(injected, 'all'), true)
  assert.equal(isSessionMessage({ type: 'assistant/message', data: {} } as unknown as SessionEvent, 'all'), false)
})

test('subagent conversations and archived conversations stay hidden whatever they contain', () => {
  const archived = new Set(['archived'])
  assert.equal(sessionVisible({ id: 'a', hasMessage: true }, new Set()), true)
  assert.equal(sessionVisible({ id: 'a', hasMessage: false }, new Set()), false)
  assert.equal(sessionVisible({ id: 'a', origin: 'subagent', hasMessage: true }, new Set()), false)
  assert.equal(sessionVisible({ id: 'archived', hasMessage: true }, archived), false)
})

test('settings reject a scope outside the list and keep the saved one otherwise', () => {
  const scope = (value: string): SessionSyncScope => value as SessionSyncScope
  assert.throws(() => validateConnectorSettings({ ...DEFAULT_CONNECTOR_SETTINGS, sessionSyncScope: scope('everyone') }), /会话范围/)
  assert.equal(validateConnectorSettings({ ...DEFAULT_CONNECTOR_SETTINGS, sessionSyncScope: 'all' }).sessionSyncScope, 'all')
  assert.equal(validateConnectorSettings({ ...DEFAULT_CONNECTOR_SETTINGS }).sessionSyncScope, 'human')
})
