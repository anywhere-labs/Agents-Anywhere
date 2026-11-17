import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { RpcContext } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AttachHub, CONNECTION_METADATA, DEFAULT_REGISTRATION, DeviceServices, blobLookup, deviceTransferUploader, type Egress } from '../../src/link/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { ATTACHMENT_META, AttachmentCache, type AttachmentSource } from '../../src/workspace/index.js'

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const egress = (): Egress => ({ proxy: null, source: 'test' })

interface Received {
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
  complete: boolean
}

/** The Server's `PUT /api/v3/device/transfers/{transferId}`, with switches for the failure paths. */
class TransferServer {
  public readonly received: Received[] = []
  public url = ''
  /** Statuses to answer the next requests with (after reading their bodies); 204 when empty. */
  public statuses: number[] = []
  /** Stop reading after the first chunk and never answer (a stalled reader). */
  public stall = false
  public onFirstChunk: (() => void) | null = null
  public closed: Promise<void> = Promise.resolve()
  private server: Server | null = null
  private current: IncomingMessage | null = null

  /** Reads on after a stall; a paused request notices its connection closed only then. */
  public release(): void {
    this.stall = false
    this.current?.resume()
  }

  public async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const entry: Received = { url: `${req.method} ${req.url}`, headers: req.headers, body: Buffer.alloc(0), complete: false }
    this.received.push(entry)
    const parts: Buffer[] = []
    let resolveClosed!: () => void
    this.closed = new Promise(resolve => (resolveClosed = resolve))
    req.once('close', () => resolveClosed())
    this.current = req
    req.on('data', (chunk: Buffer) => {
      parts.push(chunk)
      entry.body = Buffer.concat(parts)
      if (parts.length === 1) this.onFirstChunk?.()
      if (this.stall) req.pause()
    })
    req.once('end', () => {
      entry.complete = true
      const status = this.statuses.shift() ?? 204
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 204 ? undefined : JSON.stringify({ detail: `status ${status}` }))
    })
  }

  public async close(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve())
  }
}

let dir: string
let store: RemoteStore
let http: TransferServer
let cache: AttachmentCache
let uploads: Map<string, Buffer>
let invalidated: number
/** `${sessionId}:${blobId}` pairs a timeline item points at (the store's blob_refs, kept by the timeline). */
const owned = new Set<string>()

/** A timeline blob of sess_1. */
async function timelineBlob(bytes: Buffer, mediaType: string | null) {
  const record = await store.blobs.put(bytes, { mediaType, origin: 'test', at: new Date().toISOString() })
  owned.add(`sess_1:${record.blobId}`)
  return record
}

function services(): DeviceServices {
  const handshake = { accessToken: async () => `dat_${invalidated}`, invalidate: () => void invalidated++ }
  return new DeviceServices({
    connectionId: () => 'lc_1',
    attach: new AttachHub({}),
    outbox: {} as never,
    watch: {} as never,
    readers: {} as never,
    inbox: {} as never,
    blobs: {
      find: blobLookup({
        blobs: { get: id => store.blobs.get(id), path: id => store.blobs.path(id), referencedBy: async (sessionId, id) => owned.has(`${sessionId}:${id}`) },
        attachment: (sessionId, fileId) => cache.find(sessionId, fileId),
      }),
      upload: deviceTransferUploader(http.url, handshake, egress, 5_000),
    },
  })
}

async function readBlob(request: Record<string, unknown>, signal = new AbortController().signal): Promise<{ seq: number; chunk: Record<string, unknown>; end: boolean }[]> {
  const built = services().build({ 'aa.device.v1.Store': ['readBlob'] }, null)
  const service = built.services[0] as { readBlob: (request: Record<string, unknown>, context: RpcContext) => AsyncIterable<{ seq: number; chunk: Record<string, unknown>; end: boolean }> }
  const items = []
  for await (const item of service.readBlob(request, { signal, metadata: { [CONNECTION_METADATA]: 'lc_1' } } as unknown as RpcContext)) items.push(item)
  return items
}

const transfer = { transferId: 'tr_1', token: 'tt_1', path: '/api/v3/device/transfers/tr_1' }

async function consumedRecords(): Promise<Record<string, unknown>[]> {
  return (await store.outbox.pending(0, 100)).filter(record => record.kind === 'attachment.consumed').map(record => ({ sessionId: record.sessionId, ...record.payload }))
}

beforeEach(async () => {
  owned.clear()
  dir = mkdtempSync(join(tmpdir(), 'aa-blob-'))
  store = inProcessStore(openSqliteStore({ dataDir: join(dir, 'store'), durability: 'normal', now: () => new Date().toISOString() }))
  http = new TransferServer()
  await http.start()
  uploads = new Map()
  invalidated = 0
  // Sealed uploads in this test: 16 bytes of "tag" in front of the plaintext.
  const openSealed = (ciphertext: Buffer): Buffer => ciphertext.subarray(16)
  cache = new AttachmentCache(join(dir, 'attachments'), async fileId => (async function* () {
    const body = uploads.get(fileId) ?? Buffer.alloc(0)
    yield body.subarray(0, 3)
    yield body.subarray(3)
  })(), openSealed, {
    onStored: async ({ sessionId, fileId, sha256 }) => {
      await store.outbox.append('attachment.consumed', sessionId, { fileId, sha256 }, new Date().toISOString())
    },
  })
})

afterEach(async () => {
  await http.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Store/readBlob', () => {
  it('sends a timeline blob: metadata first, then the bytes as one PUT with both tokens', async () => {
    const bytes = Buffer.from('a large tool output '.repeat(5000))
    const record = await timelineBlob(bytes, 'text/plain')
    const items = await readBlob({ sessionId: 'sess_1', blobRef: record.blobId, transfer })
    expect(items[0]).toEqual({ seq: 0, chunk: { name: record.blobId, mediaType: 'text/plain', size: bytes.length, sha256: sha(bytes) }, end: false })
    expect(items.at(-1)).toEqual({ seq: 1, chunk: { done: true }, end: true })
    expect(http.received).toHaveLength(1)
    const put = http.received[0]!
    expect(put.url).toBe('PUT /api/v3/device/transfers/tr_1')
    expect(put.headers.authorization).toBe('Bearer dat_0')
    expect(put.headers['x-transfer-token']).toBe('tt_1')
    expect(put.headers['content-length']).toBe(String(bytes.length))
    expect(put.body.equals(bytes)).toBe(true)
  })

  it('sends an attachment the device took, with its original name and type, and reports consumed once', async () => {
    const body = Buffer.from('png-bytes-here')
    uploads.set('file_a', body)
    const source: AttachmentSource = { fileId: 'file_a', name: 'shot 1.png', mediaType: 'image/png', size: body.length, sha256: `sha256:${sha(body)}` }
    const [first, second] = await Promise.all([cache.resolve('sess_1', source), cache.resolve('sess_1', source)])
    await cache.resolve('sess_1', source)
    expect(first).toEqual(second)
    // Durable metadata next to the file, and exactly one consumed report with the digest the Server staged.
    expect(JSON.parse(readFileSync(join(dirname(first.path), ATTACHMENT_META), 'utf8'))).toMatchObject({ fileId: 'file_a', name: 'shot 1.png', mediaType: 'image/png', size: body.length, sha256: sha(body) })
    expect(await consumedRecords()).toEqual([{ sessionId: 'sess_1', fileId: 'file_a', sha256: sha(body) }])

    const items = await readBlob({ sessionId: 'sess_1', blobRef: 'file_a', transfer })
    expect(items[0]!.chunk).toEqual({ name: 'shot 1.png', mediaType: 'image/png', size: body.length, sha256: sha(body) })
    expect(items.at(-1)).toMatchObject({ chunk: { done: true }, end: true })
    expect(http.received[0]!.body.equals(body)).toBe(true)
    expect(http.received[0]!.headers['content-type']).toBe('image/png')
    // Another session does not see it.
    await expect(readBlob({ sessionId: 'sess_2', blobRef: 'file_a', transfer })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports the ciphertext digest for a sealed upload and serves the plaintext', async () => {
    const plaintext = Buffer.from('secret attachment')
    const ciphertext = Buffer.concat([Buffer.alloc(16, 7), plaintext])
    uploads.set('file_s', ciphertext)
    await cache.resolve('sess_1', { fileId: 'file_s', name: 'a.txt', mediaType: 'text/plain', size: plaintext.length, sha256: sha(plaintext), sealedKey: 'k'.repeat(43) })
    expect(await consumedRecords()).toEqual([{ sessionId: 'sess_1', fileId: 'file_s', sha256: sha(ciphertext) }])
    const items = await readBlob({ sessionId: 'sess_1', blobRef: 'file_s', transfer })
    expect(items[0]!.chunk).toMatchObject({ size: plaintext.length, sha256: sha(plaintext) })
    expect(http.received[0]!.body.equals(plaintext)).toBe(true)
  })

  it('serves a download from before metadata was written', async () => {
    const body = Buffer.from('old download')
    uploads.set('file_o', body)
    const local = await cache.resolve('sess_1', { fileId: 'file_o', name: 'old.bin', mediaType: 'image/png', size: body.length })
    unlinkSync(join(dirname(local.path), ATTACHMENT_META))
    const items = await readBlob({ sessionId: 'sess_1', blobRef: 'file_o', transfer })
    expect(items[0]!.chunk).toEqual({ name: 'old.bin', mediaType: 'application/octet-stream', size: body.length, sha256: sha(body) })
    expect(http.received[0]!.body.equals(body)).toBe(true)
  })

  it('serves a session only the blobs its own timeline points at', async () => {
    const record = await timelineBlob(Buffer.from('mine'), null)
    await expect(readBlob({ sessionId: 'sess_2', blobRef: record.blobId, transfer })).rejects.toMatchObject({ code: 'not_found' })
    expect(http.received).toHaveLength(0)
  })

  it('answers not_found for an unknown blob or file, without uploading', async () => {
    await expect(readBlob({ sessionId: 'sess_1', blobRef: `blob_${'0'.repeat(64)}`, transfer })).rejects.toMatchObject({ code: 'not_found' })
    await expect(readBlob({ sessionId: 'sess_1', blobRef: 'file_missing', transfer })).rejects.toMatchObject({ code: 'not_found' })
    expect(http.received).toHaveLength(0)
  })

  it('refreshes the token once on 401 and sends the file again from the start', async () => {
    const bytes = Buffer.from('retry me '.repeat(1000))
    const record = await timelineBlob(bytes, null)
    http.statuses = [401]
    const items = await readBlob({ sessionId: 'sess_1', blobRef: record.blobId, transfer })
    expect(items[0]!.chunk).toMatchObject({ mediaType: 'application/octet-stream' })
    expect(invalidated).toBe(1)
    expect(http.received.map(r => r.headers.authorization)).toEqual(['Bearer dat_0', 'Bearer dat_1'])
    expect(http.received[1]!.body.equals(bytes)).toBe(true)
  })

  it('ends as cancelled when the reader went away (410)', async () => {
    const record = await timelineBlob(Buffer.from('gone'), null)
    http.statuses = [410]
    await expect(readBlob({ sessionId: 'sess_1', blobRef: record.blobId, transfer })).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('aborts the upload when the call is cancelled', async () => {
    const bytes = Buffer.alloc(16 * 1024 * 1024, 1)
    const record = await timelineBlob(bytes, null)
    http.stall = true
    const abort = new AbortController()
    http.onFirstChunk = () => abort.abort()
    await expect(readBlob({ sessionId: 'sess_1', blobRef: record.blobId, transfer }, abort.signal)).rejects.toThrow(/aborted/u)
    http.release()
    await http.closed
    expect(http.received[0]!.complete).toBe(false)
    expect(http.received[0]!.body.length).toBeLessThan(bytes.length)
  })

  it('refuses a transfer path on another origin', async () => {
    const record = await timelineBlob(Buffer.from('x'), null)
    await expect(readBlob({ sessionId: 'sess_1', blobRef: record.blobId, transfer: { ...transfer, path: 'https://elsewhere.example/x' } })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(http.received).toHaveLength(0)
  })

  it('is not registered in encrypted mode', () => {
    expect(DEFAULT_REGISTRATION.required['aa.device.v1.Store']).toBeUndefined()
    expect(DEFAULT_REGISTRATION.off['aa.device.v1.Store']).toContain('readBlob')
  })
})
