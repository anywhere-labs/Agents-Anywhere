// `GET sessions/{id}/blobs/{blobRef}` and the attachments a user message keeps whatever the Runtime echoes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { settle, testDevice, type TestDevice } from '../support/client-device.js'

let device: TestDevice
const S = 'sess_blobs'
const at = (path: string, sessionId = S): string => `/sessions/${sessionId}${path}`
const detail = (body: unknown): { code?: string; message?: string } => (body as { detail?: { code?: string; message?: string } }).detail ?? {}

interface Chunk { blobRef: string; name: string; mediaType: string; encoding: string; data: string; offset: number; size: number; eof: boolean }
interface Item { id: string; role: string | null; content: Record<string, unknown>; blobRefs?: { path: string; blobId: string; bytes: number; mediaType: string | null }[] }

beforeEach(async () => {
  device = await testDevice()
})

afterEach(async () => {
  await device.close()
})

async function timeline(sessionId = S): Promise<Item[]> {
  const read = await device.request('GET', at('/timeline', sessionId))
  expect(read.status, JSON.stringify(read.body)).toBe(200)
  return (read.body as { items: Item[] }).items
}

/** A finished tool call whose output is large enough to move to the blob store. */
async function bigOutput(output: string): Promise<Item> {
  const session = device.sessions[0]!
  session.emit({ type: 'tool.started', turnId: 'tb', itemId: 'tool_big', toolCallId: 'call_big', kind: 'command', title: 'cat big.log', status: 'running' })
  session.emit({ type: 'tool.updated', turnId: 'tb', itemId: 'tool_big', toolCallId: 'call_big', status: 'done', output })
  await settle()
  const item = (await timeline()).find(entry => entry.id === 'tool_big')
  expect(item?.blobRefs?.length).toBe(1)
  return item!
}

async function readAll(blobRef: string, length: number, sessionId = S): Promise<{ bytes: Buffer; chunks: Chunk[] }> {
  const chunks: Chunk[] = []
  let offset = 0
  for (;;) {
    const answer = await device.request('GET', `${at(`/blobs/${encodeURIComponent(blobRef)}`, sessionId)}?offset=${offset}&length=${length}`)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const chunk = answer.body as Chunk
    chunks.push(chunk)
    expect(chunk.offset).toBe(offset)
    offset += Buffer.from(chunk.data, 'base64').length
    if (chunk.eof) break
  }
  return { bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))), chunks }
}

describe('session blobs', () => {
  it('reads a moved field back in slices, exactly as the Runtime sent it', async () => {
    await device.start(S)
    const output = Array.from({ length: 4000 }, (_, i) => `line ${i} 输出 ${'x'.repeat(i % 17)}`).join('\n')
    const item = await bigOutput(output)
    const ref = item.blobRefs![0]!
    expect(ref).toMatchObject({ mediaType: 'text/plain; charset=utf-8', bytes: Buffer.byteLength(output) })
    expect(String(item.content.output)).toContain('可展开查看')
    const { bytes, chunks } = await readAll(ref.blobId, 50_000)
    expect(bytes.toString('utf8')).toBe(output)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)).toMatchObject({ blobRef: ref.blobId, mediaType: 'text/plain; charset=utf-8', encoding: 'base64', size: ref.bytes, eof: true })
    // One read by default.
    expect((await readAll(ref.blobId, 4 * 1024 * 1024)).chunks).toHaveLength(1)
  })

  it('answers 404 for a blob the session does not point at, and 422 for a bad range', async () => {
    await device.start(S)
    const item = await bigOutput('y'.repeat(60_000))
    const blobId = item.blobRefs![0]!.blobId
    const unknown = await device.request('GET', at(`/blobs/blob_${'0'.repeat(64)}`))
    expect(unknown.status).toBe(404)
    expect(detail(unknown.body).code).toBe('blob_not_found')
    // Content-addressed ids are shared across sessions: another session cannot read this one's blob.
    await device.store.sessions.create({ sessionId: 'sess_other', runtimeType: 'opencode', runtimeId: 'rt_opencode', externalSessionId: null, cwd: device.root, nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: true, at: new Date().toISOString() })
    const foreign = await device.request('GET', at(`/blobs/${blobId}`, 'sess_other'))
    expect(foreign.status).toBe(404)
    expect(detail(foreign.body).code).toBe('blob_not_found')
    expect((await device.request('GET', at(`/blobs/${blobId}`, 'sess_missing'))).status).toBe(404)
    expect((await device.request('GET', `${at(`/blobs/${blobId}`)}?length=${4 * 1024 * 1024 + 1}`)).status).toBe(422)
    expect((await device.request('GET', `${at(`/blobs/${blobId}`)}?offset=-1`)).status).toBe(422)
    expect((await device.request('GET', `${at(`/blobs/${blobId}`)}?offset=60001`)).status).toBe(422)
    const end = await device.request('GET', `${at(`/blobs/${blobId}`)}?offset=60000`)
    expect(end.body).toMatchObject({ data: '', offset: 60000, size: 60000, eof: true })
  })
})

describe('user message attachments', () => {
  const facts = [{ fileId: 'file_img', name: 'photo.png', mediaType: 'image/png', size: 3, sha256: 'a'.repeat(64) }]
  const shown = [{ fileId: 'file_img', name: 'photo.png', mediaType: 'image/png', size: 3, sha256: 'a'.repeat(64) }]

  it('records the attachments of a sent message when the Runtime does not echo it', async () => {
    await device.start(S)
    const sent = await device.request('POST', at('/runtime/messages'), { content: 'look', clientMessageId: 'cm_att', attachments: [{ fileId: 'file_img' }] }, { server: { attachments: facts } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    await device.runTurn('look')
    const user = (await timeline()).find(item => item.role === 'user' && item.content.clientMessageId === 'cm_att')
    expect(user?.content.attachments).toEqual(shown)
  })

  it('keeps them when the Runtime echoes the message under its own id, and when history projects it again', async () => {
    await device.start(S)
    await device.request('POST', at('/runtime/messages'), { content: 'look', clientMessageId: 'cm_echo', attachments: [{ fileId: 'file_img' }] }, { server: { attachments: facts } })
    await device.runTurn('look')
    const session = device.sessions[0]!
    // The Runtime's own echo names no attachments.
    session.emit({ type: 'message.completed', itemId: 'native_user_1', role: 'user', text: 'look', clientMessageId: 'cm_echo' })
    await settle()
    let users = (await timeline()).filter(item => item.role === 'user' && item.content.clientMessageId === 'cm_echo')
    expect(users.map(item => item.id)).toEqual(['native_user_1'])
    expect(users[0]!.content.attachments).toEqual(shown)
    // A later projection of the same message (a history replay) without attachments keeps them.
    session.emit({ type: 'message.completed', itemId: 'native_user_1', role: 'user', text: 'look (edited)' })
    await settle()
    users = (await timeline()).filter(item => item.id === 'native_user_1')
    expect(users[0]!.content).toMatchObject({ text: 'look (edited)', attachments: shown })
  })

  it('records the attachments of a send the Runtime refused', async () => {
    await device.start(S)
    device.sessions[0]!.nextPrompt = { outcome: 'rejected', error: { code: 'runtime_busy', message: 'busy' } }
    await device.request('POST', at('/runtime/messages'), { content: 'look', clientMessageId: 'cm_fail', attachments: [{ fileId: 'file_img' }] }, { server: { attachments: facts } })
    await settle()
    const failed = (await timeline()).find(item => item.content.clientMessageId === 'cm_fail')
    expect(failed?.content).toMatchObject({ attachments: shown, error: { code: 'runtime_busy' } })
  })
})
