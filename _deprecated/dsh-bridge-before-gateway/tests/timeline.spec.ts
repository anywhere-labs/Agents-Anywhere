import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { projectTimeline } from '../src/projection/timeline.js'

const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => void
const schemaPath = fileURLToPath(new URL('../../contracts/dsh-bridge/1.0/schemas/timeline-item.schema.json', import.meta.url))

const header: SessionHeader = {
  version: 0,
  id: SessionId('session-1'),
  createdAt: 1,
  cwd: '/workspace',
}

describe('normalized timeline projection', () => {
  it('projects allowlisted events and validates every item against the shared schema', async () => {
    const events = [
      {
        type: 'user/message', seq: 0, time: 1,
        data: {
          id: MessageId('private-context'), role: 'user',
          content: [{ type: 'text', text: 'do not expose' }],
          source: { kind: 'plugin', plugin: 'private' },
        },
      },
      {
        type: 'user/message', seq: 1, time: 2,
        data: {
          id: MessageId('message-1'), role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'tool/call', seq: 2, time: 3,
        data: { turn: 1, step: 1, callId: CallId('call-1'), name: 'read', arguments: '{"path":"file"}' },
      },
      {
        type: 'tool/result', seq: 3, time: 4,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: MessageId('tool-result-1'),
            role: 'user',
            source: { kind: 'tool', callId: CallId('call-1') },
            content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }] }],
          },
        },
      },
    ] as unknown as SessionEvent[]
    const items = projectTimeline(header, events)
    expect(items).toHaveLength(2)
    expect(JSON.stringify(items)).not.toContain('do not expose')
    const tool = items.find(item => item.type === 'tool')
    expect(tool).toMatchObject({ status: 'done', role: 'tool', orderSeq: 2, revision: 2 })
    expect(tool?.source).toMatchObject({ eventType: 'tool/result', eventSeq: 3 })

    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false })
    addFormats(ajv)
    const validate = ajv.compile(JSON.parse(await readFile(schemaPath, 'utf8')) as AnySchema)
    for (const item of items) {
      expect(validate(item), JSON.stringify(validate.errors)).toBe(true)
    }
  })
})
