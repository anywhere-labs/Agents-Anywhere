import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  contentHash,
  decodeModelSelectionId,
  decodePermissionSelectionId,
  modelSelectionId,
  permissionSelectionId,
  platformSessionId,
  timelineItemId,
} from '../src/projection/identity.js'

const fixturePath = fileURLToPath(new URL('../../contracts/dsh-bridge/1.0/fixtures/identity.json', import.meta.url))

interface IdentityFixture {
  sessionIds: Array<{ connectorId: string; externalSessionId: string; sessionId: string }>
  modelSelections: Array<{ provider: string; model: string; effort: string | null; selectionId: string }>
  permissionSelections: Array<{ preset: string; selectionId: string }>
  timelineIds: Array<{ externalSessionId: string; projectionKind: string; businessId: string; itemId: string }>
  contentHashes: Array<{
    type: string
    status: string
    role: string
    content: Record<string, unknown>
    contentHash: string
  }>
}

describe('shared identity fixtures', () => {
  it('matches every frozen algorithm example', async () => {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as IdentityFixture
    for (const item of fixture.sessionIds) {
      expect(platformSessionId(item.connectorId, item.externalSessionId)).toBe(item.sessionId)
    }
    for (const item of fixture.modelSelections) {
      const selection = {
        provider: item.provider,
        model: item.model,
        ...(item.effort === null ? {} : { reasoningEffort: item.effort as never }),
      }
      expect(modelSelectionId(selection)).toBe(item.selectionId)
      expect(decodeModelSelectionId(item.selectionId)).toEqual(selection)
    }
    for (const item of fixture.permissionSelections) {
      expect(permissionSelectionId(item.preset)).toBe(item.selectionId)
      expect(decodePermissionSelectionId(item.selectionId)).toBe(item.preset)
    }
    for (const item of fixture.timelineIds) {
      expect(timelineItemId(item.externalSessionId, item.projectionKind, item.businessId)).toBe(item.itemId)
    }
    for (const item of fixture.contentHashes) {
      expect(contentHash({
        type: item.type,
        status: item.status,
        role: item.role,
        content: item.content,
      })).toBe(item.contentHash)
    }
  })
})
