import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetadataStore } from '../src/persistence/metadata.js'
import { sha256Hex } from '../src/projection/identity.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bridge metadata', () => {
  it('keeps bindings and creation reservations idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aa-dsh-bridge-'))
    roots.push(root)
    const store = new MetadataStore(root)
    await store.initialize()
    await expect(store.bind('platform-1', 'external-1')).resolves.toMatchObject({ version: 1 })
    await expect(store.bind('platform-1', 'external-1')).resolves.toMatchObject({ externalSessionId: 'external-1' })
    await expect(store.bind('platform-1', 'external-2')).rejects.toMatchObject({ data: { code: 'SESSION_BINDING_CONFLICT' } })
    const first = await store.reserveCreation('platform-1', 'client-1')
    const retry = await store.reserveCreation('platform-1', 'client-1')
    expect(retry.externalSessionId).toBe(first.externalSessionId)
  })

  it('rejects a client id reused with different content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aa-dsh-bridge-'))
    roots.push(root)
    const store = new MetadataStore(root)
    await store.initialize()
    await store.recordMessage({
      platformSessionId: 'platform-1',
      clientMessageId: 'client-1',
      operation: 'start',
      contentHash: sha256Hex('one'),
    })
    await expect(store.recordMessage({
      platformSessionId: 'platform-1',
      clientMessageId: 'client-1',
      operation: 'start',
      contentHash: sha256Hex('two'),
    })).rejects.toMatchObject({ data: { code: 'IDEMPOTENCY_CONFLICT' } })
  })
})
