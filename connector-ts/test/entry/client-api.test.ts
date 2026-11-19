import { describe, expect, it } from 'vitest'

import { RuntimeCatalogMemory, type RuntimeInstanceSpec } from '../../src/application/index.js'
import type { RuntimeKv } from '../../src/application/ports/index.js'
import type { RuntimeHandle } from '../../src/application/ports/index.js'
import { instanceCatalogs, preparedDownloadUpload } from '../../src/entry/client-api.js'
import type { BlobTransfer, UploadFile } from '../../src/link/index.js'

const models = { runtime: 'opencode', revision: 2, models: [{ id: 'm1', displayName: 'Model 1', selectionId: 'm1' }] }

function registry(handles: Record<string, RuntimeHandle | null>, catalogsFail = false): Parameters<typeof instanceCatalogs>[0] {
  return {
    spec: runtimeId => (runtimeId in handles ? ({ runtimeId, runtimeType: 'opencode' } as RuntimeInstanceSpec) : null),
    started: runtimeId => {
      const handle = handles[runtimeId] ?? null
      if (handle === null) return null
      return Promise.resolve({ ...handle, catalogs: async () => (catalogsFail ? Promise.reject(new Error('agent gone')) : { models }) } as unknown as RuntimeHandle)
    },
  }
}

describe('client API dependencies of the composition root', () => {
  it('instance catalogs: a started instance answers its catalogs, a stopped one none, an unknown one is absent', async () => {
    const handle = {} as RuntimeHandle
    const catalogs = instanceCatalogs(registry({ rt_on: handle, rt_off: null }))
    expect(await catalogs.catalogs('rt_on')).toEqual({ runtimeType: 'opencode', catalogs: { models } })
    expect(await catalogs.catalogs('rt_off')).toEqual({ runtimeType: 'opencode', catalogs: null })
    expect(await catalogs.catalogs('rt_none')).toBeNull()
    expect(await instanceCatalogs(registry({ rt_on: handle }, true)).catalogs('rt_on')).toEqual({ runtimeType: 'opencode', catalogs: null })
  })

  it('instance catalogs: an Agent with no open session (after a restart) answers the models it last listed, while its spec is unchanged', async () => {
    const rows = new Map<string, unknown>()
    const kv: RuntimeKv = {
      get: async (runtimeId, key) => rows.get(`${runtimeId}/${key}`) ?? null,
      entries: async runtimeId => [...rows].filter(([key]) => key.startsWith(`${runtimeId}/`))
        .map(([key, value]) => ({ key: key.slice(runtimeId.length + 1), value })),
      set: async (runtimeId, key, value) => void rows.set(`${runtimeId}/${key}`, JSON.parse(JSON.stringify(value))),
      delete: async (runtimeId, key) => void rows.delete(`${runtimeId}/${key}`),
    }
    const permissions = { runtime: 'codex', revision: 1, permissions: [{ id: 'auto', displayName: 'Auto', selectionId: 'auto' }] }
    let live: Record<string, unknown> = { models, selections: { model: 'm1' } }
    let settings: Record<string, unknown> = {}
    const registry: Parameters<typeof instanceCatalogs>[0] = {
      spec: runtimeId => ({ runtimeId, runtimeType: 'codex', settings, sourceKey: null, enabled: true }) as RuntimeInstanceSpec,
      started: () => Promise.resolve({ catalogs: async () => live } as unknown as RuntimeHandle),
    }
    const catalogs = instanceCatalogs(registry, new RuntimeCatalogMemory(kv))
    expect(await catalogs.catalogs('codex')).toEqual({ runtimeType: 'codex', catalogs: { models, selections: { model: 'm1' } } })
    // Restarted: the Agent lists permissions only, the models come from what it listed before.
    live = { permissions }
    expect(await catalogs.catalogs('codex')).toEqual({ runtimeType: 'codex', catalogs: { models, permissions, selections: { model: 'm1' } } })
    // Another configuration may offer other models: nothing is filled in.
    settings = { cliPath: '/other/codex' }
    expect(await catalogs.catalogs('codex')).toEqual({ runtimeType: 'codex', catalogs: { permissions } })
  })

  it('transfer upload: the prepared file goes to the relay path the Server named, in the background', async () => {
    const uploads: { transfer: BlobTransfer; file: UploadFile }[] = []
    const prepared: Record<string, unknown>[] = []
    const upload = preparedDownloadUpload({
      preparedFile: async params => {
        prepared.push(params)
        return { path: '/w/blob.bin', size: 3, mediaType: 'application/octet-stream' }
      },
      upload: async (transfer, file) => {
        uploads.push({ transfer, file })
      },
    })
    const result = await upload({ sessionId: 'browse_dev', root: '/w', path: '/w/blob.bin', transferId: 'tr_1', token: 'tok', uploadUrl: '/api/v3/device/transfers/tr_1' })
    expect(result).toEqual({ transferId: 'tr_1', uploadStarted: true })
    expect(prepared).toEqual([{ sessionId: 'browse_dev', root: '/w', path: '/w/blob.bin', transferId: 'tr_1', token: 'tok', uploadUrl: '/api/v3/device/transfers/tr_1' }])
    await new Promise(resolve => setImmediate(resolve))
    expect(uploads).toEqual([{ transfer: { transferId: 'tr_1', token: 'tok', path: '/api/v3/device/transfers/tr_1' }, file: { path: '/w/blob.bin', size: 3, mediaType: 'application/octet-stream' } }])
  })

  it('transfer upload: a device without the relay upload refuses it', async () => {
    await expect(preparedDownloadUpload({})({ transferId: 'tr_1', token: 'tok' })).rejects.toMatchObject({ code: 'unimplemented' })
  })
})
