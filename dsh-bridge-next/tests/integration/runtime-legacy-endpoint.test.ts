import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { RuntimeAttachments } from '../../src/host/dsh-runtime/attachments.js'

// The 1.0 endpoint mirror (`<DSH_HOME>/agents-anywhere/bridge/endpoint.json`) is
// gone: the plugin no longer publishes an endpoint at all and the Connector
// publishes the 2.0 rendezvous itself. Tests for mirror takeover, mirror
// cleanup and a pre-2.0.3 plugin's legacy lease were deleted with it. Legacy
// upload staging is a separate compatibility path and is still read.

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
