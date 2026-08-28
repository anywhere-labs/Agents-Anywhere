import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { projectTimeline } from '../src/bridge/projection/timeline.js'

const header: SessionHeader = {
  version: 0,
  id: SessionId('session-1'),
  createdAt: 1,
  cwd: '/workspace',
}

describe('timeline projection', () => {
  it('projects only allowlisted safe fields', () => {
    const events = [
      {
        type: 'request/context', seq: 0, time: 1,
        data: { provider: 'secret-provider', model: 'secret-model' },
      },
      {
        type: 'user/message', seq: 1, time: 2,
        data: {
          id: MessageId('plugin-message'), role: 'user',
          content: [{ type: 'text', text: 'internal context' }],
          source: { kind: 'plugin', plugin: 'private' },
        },
      },
      {
        type: 'user/message', seq: 2, time: 3,
        data: {
          id: MessageId('user-message'), role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'tool/call', seq: 3, time: 4,
        data: { turn: 1, step: 1, callId: CallId('call-1'), name: 'read', arguments: '{"path":"file"}' },
      },
    ] as unknown as SessionEvent[]
    const items = projectTimeline(header, events)
    expect(items).toHaveLength(2)
    expect(items[0]?.payload).toMatchObject({ role: 'user', text: 'hello', messageId: 'user-message' })
    expect(items[1]?.payload).toMatchObject({ callId: 'call-1', name: 'read', arguments: { path: 'file' }, status: 'running' })
    expect(items[1]?.type).toBe('tool')
    expect(JSON.stringify(items)).not.toContain('secret-provider')
    expect(JSON.stringify(items)).not.toContain('internal context')
  })

  it('merges tool/call and tool/result into one unified done tool item', () => {
    const events = [
      {
        type: 'tool/call', seq: 1, time: 2,
        data: { turn: 1, step: 1, callId: CallId('call-bash-1'), name: 'bash', arguments: '{"command":"sw_vers"}' },
      },
      {
        type: 'tool/result', seq: 2, time: 3,
        data: {
          turn: 1, step: 1, callId: CallId('call-bash-1'),
          message: {
            content: [{ type: 'tool_result', toolCallId: 'call-bash-1', content: [{ type: 'text', text: 'macOS 15.0.1' }] }],
          },
        },
      },
    ] as unknown as SessionEvent[]
    const items = projectTimeline(header, events)
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('tool')
    expect(items[0]?.payload).toMatchObject({
      callId: 'call-bash-1',
      name: 'bash',
      arguments: { command: 'sw_vers' },
      text: 'macOS 15.0.1',
      status: 'done',
    })
  })
})
