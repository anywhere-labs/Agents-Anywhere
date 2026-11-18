import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RpcContext } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TimelineDraft } from '../../src/domain/conversation/index.js'
import { AttachHub, CONNECTION_METADATA, DeviceServices, type LocalBlob } from '../../src/link/index.js'
import { STRING_MAX, inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, SHARE_CHUNK_BYTES, shareChunks, type HistoryBackfill } from '../../src/sync/index.js'

let dir: string
let store: RemoteStore
let tick = 0
const now = () => `2026-11-18T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`

const message = (id: string, text: string, order: number, patch: Partial<TimelineDraft> = {}): TimelineDraft => ({
  id, type: 'message', status: 'done', role: 'assistant', orderSeq: order, content: { text }, source: { runtime: 'codex' }, createdAt: 't', ...patch,
})

type Chunk = { seq: number; chunk: { items: Record<string, unknown>[]; attachments: string[] }; end: boolean }

async function createSession(sessionId = 'sess_1') {
  await store.sessions.create({
    sessionId, runtimeType: 'codex', runtimeId: 'rti_1', externalSessionId: `th_${sessionId}`, cwd: '/work', nativeTitle: 'Title',
    status: 'idle', sourceAvailability: 'available', takeover: true, at: now(),
  })
}

function services(options: { history?: HistoryBackfill; held?: ReadonlySet<string> } = {}): DeviceServices {
  const held = options.held ?? new Set<string>()
  const blob = (id: string): LocalBlob => ({ path: `/tmp/${id}`, name: id, mediaType: 'image/png', size: 1, sha256: 'x' })
  return new DeviceServices({
    connectionId: () => 'lc_1',
    attach: new AttachHub({}),
    outbox: {} as never,
    watch: {} as never,
    readers: new DeviceReaders(store, now, undefined, options.history ?? null),
    inbox: {} as never,
    blobs: { find: async (_sessionId, id) => (held.has(id) ? blob(id) : null), upload: async () => undefined },
  })
}

async function exportShare(request: Record<string, unknown>, deviceServices = services()): Promise<Chunk[]> {
  const built = deviceServices.build({ 'aa.device.v1.Store': ['exportShare'] }, null)
  const service = built.services[0] as { exportShare: (request: Record<string, unknown>, context: RpcContext) => AsyncIterable<Chunk> }
  const chunks: Chunk[] = []
  const context = { signal: new AbortController().signal, metadata: { [CONNECTION_METADATA]: 'lc_1' } } as unknown as RpcContext
  for await (const chunk of service.exportShare(request, context)) chunks.push(chunk)
  return chunks
}

const merged = (chunks: Chunk[]) => ({
  items: chunks.flatMap(chunk => chunk.chunk.items),
  attachments: [...new Set(chunks.flatMap(chunk => chunk.chunk.attachments))],
})

beforeEach(() => {
  tick = 0
  dir = mkdtempSync(join(tmpdir(), 'aa-share-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now }))
})

afterEach(async () => {
  await store.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('Store/exportShare', () => {
  it('exports a whole session in timeline order, with the attachments this device holds', async () => {
    await createSession()
    const question = message('q', 'what is in the picture?', 1024, {
      role: 'user',
      content: { text: 'what is in the picture?', attachments: [{ fileId: 'file_pic', name: 'pic.png', mediaType: 'image/png' }, { fileId: 'file_gone', name: 'gone.txt' }] },
    })
    await store.timeline.apply('sess_1', { upserts: [message('a', 'a cat', 2048), question], at: now() })
    const chunks = await exportShare({ sessionId: 'sess_1', selection: { scope: 'session' }, byteBudget: 8 * 1024 * 1024 }, services({ held: new Set(['file_pic']) }))
    expect(chunks.at(-1)!.end).toBe(true)
    expect(chunks.map(chunk => chunk.seq)).toEqual(chunks.map((_chunk, index) => index))
    const { items, attachments } = merged(chunks)
    expect(items.map(item => item.id)).toEqual(['q', 'a'])
    expect(items[0]).toMatchObject({ sessionId: 'sess_1', type: 'message', role: 'user', orderSeq: 1024, revision: 1, source: { runtime: 'codex' } })
    expect(typeof items[0]!.updatedSeq).toBe('number')
    // A file the device no longer holds is left to the Server to report as missing.
    expect(attachments).toEqual(['file_pic'])
  })

  it('exports only the selected items of a reply share and leaves out ids that are not here', async () => {
    await createSession()
    await store.timeline.apply('sess_1', { upserts: [message('a', 'one', 1024), message('b', 'two', 2048), message('c', 'three', 3072)], at: now() })
    const { items } = merged(await exportShare({ sessionId: 'sess_1', selection: { scope: 'message', itemIds: ['c', 'a', 'nope'] } }))
    expect(items.map(item => item.id)).toEqual(['a', 'c'])
    await expect(exportShare({ sessionId: 'sess_1', selection: { scope: 'message', itemIds: [] } })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('puts long text back inline, keeps media as a placeholder and drops blob references', async () => {
    await createSession()
    const long = 'line of tool output\n'.repeat(Math.ceil((STRING_MAX + 100) / 20))
    const image = Buffer.alloc(3000, 7).toString('base64')
    const tool: TimelineDraft = {
      id: 't1', type: 'tool', status: 'done', role: null, orderSeq: 1024, source: { runtime: 'codex' }, createdAt: 't',
      content: { output: long, result: [{ type: 'image', data: image, mimeType: 'image/png' }] },
    }
    const [stored] = (await store.timeline.apply('sess_1', { upserts: [tool], at: now() })).changed
    expect(stored!.blobRefs).toHaveLength(2)
    const { items } = merged(await exportShare({ sessionId: 'sess_1', selection: { scope: 'session' }, byteBudget: 8 * 1024 * 1024 }))
    const content = items[0]!.content as { output: string; result: Record<string, unknown>[] }
    expect(content.output).toBe(long)
    expect(content.result[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(content.result[0]!.data).toBeUndefined()
    expect(items[0]!.blobRefs).toBeUndefined()

    // With little room the preview stays instead.
    const small = merged(await exportShare({ sessionId: 'sess_1', selection: { scope: 'session' }, byteBudget: 16 * 1024 }))
    expect((small.items[0]!.content as { output: string }).output.length).toBeLessThan(long.length)
  })

  it('refuses a snapshot above the byte budget instead of cutting it', async () => {
    await createSession()
    const drafts = Array.from({ length: 20 }, (_, i) => message(`m${i}`, 'x'.repeat(1000), (i + 1) * 1024))
    await store.timeline.apply('sess_1', { upserts: drafts, at: now() })
    await expect(exportShare({ sessionId: 'sess_1', selection: { scope: 'session' }, byteBudget: 8192 })).rejects.toMatchObject({ code: 'share_too_large' })
  })

  it('projects older native history first, and shares what is stored when the record cannot be read', async () => {
    await createSession()
    await store.timeline.apply('sess_1', { upserts: [message('new', 'latest', 10 * 1024)], at: now() })
    let older = true
    const calls: (number | null)[] = []
    const history: HistoryBackfill = {
      ensureLatest: async () => undefined,
      hasOlder: async () => older,
      ensureBefore: async (_sessionId, before) => {
        calls.push(before)
        await store.timeline.apply('sess_1', { upserts: [message('old', 'from the native record', 1024)], at: now() })
        older = false
        return true
      },
    }
    const { items } = merged(await exportShare({ sessionId: 'sess_1', selection: { scope: 'session' } }, services({ history })))
    expect(calls).toEqual([10 * 1024])
    expect(items.map(item => item.id)).toEqual(['old', 'new'])

    // A Runtime that cannot read its record adds nothing: the export goes on with the stored items.
    const stuck: HistoryBackfill = { ensureLatest: async () => undefined, hasOlder: async () => true, ensureBefore: async () => false }
    expect(merged(await exportShare({ sessionId: 'sess_1', selection: { scope: 'session' } }, services({ history: stuck }))).items).toHaveLength(2)
  })

  it('answers session_not_found for a session that is not on this device', async () => {
    await expect(exportShare({ sessionId: 'sess_x', selection: { scope: 'session' } })).rejects.toMatchObject({ code: 'session_not_found' })
  })
})

describe('shareChunks', () => {
  it('keeps every chunk below the limit, never splits an item and puts attachments on the last one', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, content: { text: 'y'.repeat(300) } }))
    const chunks = shareChunks(items, ['file_1'], 1000)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.flatMap(chunk => chunk.chunk.items)).toEqual(items)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.end).toBe(false)
      expect(chunk.chunk.attachments).toEqual([])
      expect(Buffer.byteLength(JSON.stringify(chunk.chunk.items))).toBeLessThanOrEqual(1000)
    }
    expect(chunks.at(-1)).toMatchObject({ end: true, chunk: { attachments: ['file_1'] } })
    expect(shareChunks([], [])).toEqual([{ seq: 0, chunk: { items: [], attachments: [] }, end: true }])
    expect(SHARE_CHUNK_BYTES).toBeLessThan(4 * 1024 * 1024)
  })
})
