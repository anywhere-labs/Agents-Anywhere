import { chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MetadataStore } from '../src/persistence/metadata.js'
import { sha256Hex } from '../src/projection/identity.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aa-dsh-metadata-'))
  if (process.platform !== 'win32') await chmod(root, 0o700)
})

describe('durable Bridge metadata', () => {
  it('keeps bindings and creation reservations stable across store instances', async () => {
    const first = new MetadataStore(root)
    await first.initialize()
    await first.bind('platform-1', 'external-1')
    const reservation = await first.reserveCreation('platform-2', 'client-1')

    const second = new MetadataStore(root)
    await second.initialize()
    expect(second.bindingForPlatform('platform-1')).toMatchObject({ externalSessionId: 'external-1' })
    expect(await second.reserveCreation('platform-2', 'client-1')).toEqual(reservation)
    await expect(second.bind('platform-1', 'external-2')).rejects.toMatchObject({
      data: { code: 'SESSION_CONFLICT', details: { code: 'SESSION_BINDING_CONFLICT' } },
    })
  })

  it('rejects reuse of one clientMessageId for another semantic operation', async () => {
    const store = new MetadataStore(root)
    await store.initialize()
    await store.recordMessage({
      platformSessionId: 'platform-1',
      clientMessageId: 'client-1',
      operation: 'start',
      contentHash: sha256Hex('{"content":"one"}'),
    })
    await expect(store.recordMessage({
      platformSessionId: 'platform-1',
      clientMessageId: 'client-1',
      operation: 'start',
      contentHash: sha256Hex('{"content":"two"}'),
    })).rejects.toMatchObject({ data: { code: 'IDEMPOTENCY_CONFLICT' } })
  })
})
