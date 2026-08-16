import { describe, expect, it } from 'vitest'
import { projectTimeline } from '../src/projection.js'

describe('cold timeline projection', () => {
  it('folds messages and tool updates with stable ids', () => {
    const items = projectTimeline('external', 'session', [
      { seq: 0, type: 'user/message', data: { message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] } } },
      { seq: 1, type: 'tool/call', data: { callId: 'c1', toolName: 'bash', input: { command: 'pwd' } } },
      { seq: 2, type: 'tool/result', data: { callId: 'c1', result: 'ok' } },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ type: 'message', role: 'user' })
    expect(items[1]).toMatchObject({ type: 'tool', status: 'done' })
  })
})
