import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  canonicalJson,
  contentHash,
  decodeModelSelectionId,
  decodePermissionSelectionId,
  modelSelectionId,
  permissionSelectionId,
  timelineItemId,
} from '../src/projection/identity.js'

describe('bridge v1 identities', () => {
  it('matches the frozen selection examples', () => {
    expect(modelSelectionId({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }))
      .toBe('dsh:model:WyJkZWVwc2Vlay1vZmZpY2lhbCIsImRlZXBzZWVrLXY0LWZsYXNoIixudWxsXQ')
    expect(permissionSelectionId('workspace-write')).toBe('dsh:permission:d29ya3NwYWNlLXdyaXRl')
    expect(decodePermissionSelectionId('dsh:permission:d29ya3NwYWNlLXdyaXRl')).toBe('workspace-write')
    expect(decodeModelSelectionId(modelSelectionId({
      provider: 'provider',
      model: 'model',
      reasoningEffort: ReasoningEffortId('high'),
    }))).toEqual({ provider: 'provider', model: 'model', reasoningEffort: 'high' })
  })

  it('sorts object keys before hashing timeline content', () => {
    const value = { text: '你好', role: 'user' }
    expect(canonicalJson(value)).toBe('{"role":"user","text":"你好"}')
    expect(contentHash(value)).toBe('d15fdad1e2d9d6600708b3196d06b3c03fed91e5dda43bb4ebfcd53a2c97b09c')
    expect(timelineItemId('aa-session', 'message', 'msg-1'))
      .toBe('dsh_1b44fb75409aaf21797dd98c2f5edbfa7935f50b3404d47df11b2985840533c4')
  })
})
