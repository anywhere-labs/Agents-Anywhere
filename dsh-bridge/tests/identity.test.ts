import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { contentHash, decodeModelSelection, decodePermissionSelection, modelSelectionId, permissionSelectionId, timelineId } from '../src/identity.js'

describe('wire identities', () => {
  it('round trips selections', () => {
    expect(decodeModelSelection(modelSelectionId('deepseek-official', 'deepseek-v4-flash', 'high'))).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoning: 'high' })
    expect(decodePermissionSelection(permissionSelectionId('workspace-write'))).toBe('workspace-write')
  })

  it('is deterministic', () => {
    expect(timelineId('dsh-session-id', 'message', 'message-1')).toBe('dsh_0457fb1df3b1437dd1c9f40d1d351dd5f47e5ac8d71d86a6ea7c1f9f50ffa3fa')
    expect(contentHash('message', 'done', 'user', { kind: 'text', text: '你好' })).toBe('sha256:9112741bd982a4d18053b204c84004945f09bbb20f73e3d62177f88bb75e9ac4')
  })

  it('matches the shared bridge fixture', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../contracts/dsh-bridge/1.0/fixtures/identity.json', import.meta.url), 'utf8'))
    for (const item of fixture.modelSelections) expect(modelSelectionId(item.provider, item.model, item.effort)).toBe(item.selectionId)
    for (const item of fixture.permissionSelections) expect(permissionSelectionId(item.preset)).toBe(item.selectionId)
    for (const item of fixture.timelineIds) expect(timelineId(item.externalSessionId, item.projectionKind, item.businessId)).toBe(item.itemId)
    for (const item of fixture.contentHashes) expect(contentHash(item.type, item.status, item.role, item.content)).toBe(item.contentHash)
  })
})
