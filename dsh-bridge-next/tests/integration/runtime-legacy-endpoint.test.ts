import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { RuntimeServer } from '../../src/host/dsh-runtime/server.js'
import { RuntimeAttachments } from '../../src/host/dsh-runtime/attachments.js'
import { acquireManagerLock } from '../../src/host/storage/files.js'

const reader = { query: { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => { throw new Error('unused') } }, status: () => undefined }
const gone = async (path: string) => { await assert.rejects(stat(path), { code: 'ENOENT' }) }

async function paths(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix))
  return { home, endpoint: join(home, 'dsh-bridge', 'endpoint.json'), legacy: join(home, 'dsh', 'agents-anywhere', 'bridge', 'endpoint.json') }
}

test('the owner mirrors its endpoint where Connectors before 2.0.3 look, replacing a stale copy', async t => {
  const { home, endpoint: file, legacy } = await paths('bridge-legacy-')
  await mkdir(join(legacy, '..'), { recursive: true })
  await writeFile(legacy, JSON.stringify({ version: 1, host: '127.0.0.1', port: 1, token: 'crashed-host', pid: 1 }))
  const owner = new RuntimeServer(file, reader, undefined, undefined, legacy)
  t.after(async () => { await owner.close(); await rm(home, { recursive: true, force: true }) })
  const endpoint = await owner.start()
  assert.deepEqual(JSON.parse(await readFile(legacy, 'utf8')), endpoint)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), endpoint)
  await owner.close()
  await gone(legacy)
  await gone(file)
})

test('closing leaves a legacy copy that another owner has since published', async t => {
  const { home, endpoint: file, legacy } = await paths('bridge-legacy-replaced-')
  const owner = new RuntimeServer(file, reader, undefined, undefined, legacy)
  t.after(async () => { await owner.close(); await rm(home, { recursive: true, force: true }) })
  await owner.start()
  const other = JSON.stringify({ version: 1, host: '127.0.0.1', port: 2, token: 'other-owner', pid: 2 })
  await writeFile(legacy, other)
  await owner.close()
  assert.equal(await readFile(legacy, 'utf8'), other)
})

test('a plugin before 2.0.3 that still owns the legacy path keeps it, and startup still succeeds', async t => {
  // The lease port is derived from the directory; Windows may reserve it (EACCES), so pick another.
  let fixture: Awaited<ReturnType<typeof paths>> | undefined, releaseOld: (() => Promise<void>) | undefined
  for (let attempt = 0; !releaseOld && attempt < 8; attempt++) {
    if (fixture) await rm(fixture.home, { recursive: true, force: true })
    fixture = await paths('bridge-legacy-owned-')
    releaseOld = await acquireManagerLock(fixture.legacy).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EACCES') return undefined
      throw error
    })
  }
  assert.ok(fixture && releaseOld, 'no usable lease port')
  const { home, endpoint: file, legacy } = fixture
  const old = JSON.stringify({ version: 1, host: '127.0.0.1', port: 3, token: 'older-plugin', pid: 3 })
  await writeFile(legacy, old)
  const owner = new RuntimeServer(file, reader, undefined, undefined, legacy)
  t.after(async () => { await owner.close(); await releaseOld!(); await rm(home, { recursive: true, force: true }) })
  const endpoint = await owner.start()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, endpoint.token)
  assert.equal(await readFile(legacy, 'utf8'), old)
  await owner.close()
  assert.equal(await readFile(legacy, 'utf8'), old)
})

test('uploads staged by Connectors before 2.0.3 are read from the legacy staging directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-legacy-staging-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const legacyStaging = join(home, 'dsh', 'agents-anywhere', 'bridge', 'attachments', 'staging')
  const attachments = new RuntimeAttachments(join(home, 'dsh-bridge', 'attachments'), legacyStaging)
  await attachments.initialize()
  await mkdir(legacyStaging, { recursive: true })
  const store = { imageLimits: { maxImagesPerMessage: 4, maxImageBytes: 1024, maxMessageImageBytes: 4096 } } as AttachmentStore
  const staged = async (directory: string, data: Buffer) => {
    const uploadId = randomUUID().replaceAll('-', '')
    await writeFile(join(directory, uploadId), data)
    return { uploadId, fileId: `file_${uploadId}`, name: 'image.png', mediaType: 'image/png' as const,
      size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  }
  const fromLegacy = await staged(legacyStaging, Buffer.from('legacy image'))
  const fromPrimary = await staged(attachments.staging, Buffer.from('primary image'))
  const parts = await attachments.prepare([fromLegacy, fromPrimary], store, new AbortController().signal)
  assert.deepEqual(parts.map(part => part.type === 'image' && Buffer.from(part.data, 'base64').toString()), ['legacy image', 'primary image'])
  // The primary directory wins when both hold the same upload ID.
  await writeFile(join(legacyStaging, fromPrimary.uploadId), Buffer.from('shadowed image'))
  const [primary] = await attachments.prepare([fromPrimary], store, new AbortController().signal)
  assert.equal(primary!.type === 'image' && Buffer.from(primary!.data, 'base64').toString(), 'primary image')
  await assert.rejects(attachments.prepare([{ ...fromLegacy, uploadId: 'missing' }], store, new AbortController().signal), { code: 'ENOENT' })
})
