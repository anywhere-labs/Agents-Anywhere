import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { RuntimeAttachments, parseAttachments } from '../../src/host/dsh-runtime/attachments.js'
import { isImageInputType, prepareImage } from '../../src/host/dsh-runtime/image-input.js'
import { capabilities } from '../../src/host/dsh-runtime/capabilities.js'

const signal = () => new AbortController().signal
const raster = () => sharp({ create: { width: 2, height: 3, channels: 4, background: { r: 240, g: 20, b: 30, alpha: 0.5 } } })

async function withStore(run: (store: LocalAttachmentStore, images: RuntimeAttachments) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'aa-image-input-'))
  const ctx = new Context()
  const store = new LocalAttachmentStore(ctx, { dshHome: home })
  const images = new RuntimeAttachments(join(home, 'uploads'))
  try { await images.initialize(); await run(store, images) }
  finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
}

async function stage(images: RuntimeAttachments, data: Buffer, mediaType: string, name = 'image') {
  const uploadId = randomUUID().replaceAll('-', '')
  await writeFile(join(images.staging, uploadId), data)
  return parseAttachments([{ uploadId, fileId: `file_${uploadId}`, name, mediaType,
    size: data.length, sha256: createHash('sha256').update(data).digest('hex') }])[0]!
}

for (const format of ['avif', 'tiff'] as const) {
  test(`${format} is converted to a real PNG accepted by official DSH admission, preserving the original upload`, async () => {
    await withStore(async (store, images) => {
      const data = await (format === 'tiff' ? raster().tiff({ compression: 'deflate' }) : raster().avif()).toBuffer()
      const file = await stage(images, data, `image/${format}`, `photo.${format}`)
      const parts = await images.prepare([file], store, signal())
      assert.equal(parts.length, 1)
      const part = parts[0]!
      assert.equal(part.type, 'image')
      if (part.type !== 'image') throw new Error('missing image')
      assert.equal(part.mediaType, 'image/png')
      assert.equal(part.name, file.name)
      const decoded = await sharp(Buffer.from(part.data, 'base64')).metadata()
      assert.equal(decoded.format, 'png')
      assert.equal(decoded.width, 2)
      assert.equal(decoded.height, 3)
      assert.equal(decoded.hasAlpha, true)
      const admitted = await store.admitPromptContent(parts)
      const block = admitted[0]!
      if (block.type !== 'image') throw new Error('missing admitted image')
      assert.equal(block.attachment.mediaType, 'image/png')
      assert.ok((await store.readImage(block.attachment)).data.length > 0)
      assert.deepEqual(await readFile(join(images.staging, file.uploadId)), data)
    })
  })
}

test('native image inputs retain their bytes and media type', async () => {
  await withStore(async store => {
    for (const [format, mediaType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']] as const) {
      const data = await raster()[format]().toBuffer()
      const prepared = await prepareImage(data, mediaType, store.imageLimits, signal())
      assert.equal(prepared.data, data)
      assert.equal(prepared.mediaType, mediaType)
    }
  })
})

test('TIFF conversion applies EXIF orientation before stripping metadata', async () => {
  await withStore(async store => {
    const data = await raster().withMetadata({ orientation: 6 }).tiff().toBuffer()
    const prepared = await prepareImage(data, 'image/tiff', store.imageLimits, signal())
    const metadata = await sharp(prepared.data).metadata()
    assert.equal(metadata.width, 3)
    assert.equal(metadata.height, 2)
    assert.equal(metadata.orientation, undefined)
    assert.equal(metadata.exif, undefined)
  })
})

test('malformed, mismatched, and active document bytes cannot enter the image conversion path', async () => {
  await withStore(async store => {
    for (const data of [Buffer.from('private invalid contents'), await raster().png().toBuffer(),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"></svg>')]) {
      for (const mediaType of ['image/avif', 'image/tiff'] as const) {
        await assert.rejects(prepareImage(data, mediaType, store.imageLimits, signal()), error => {
          assert.equal(Reflect.get(error as object, 'code'), 'INVALID_PARAMS')
          assert.equal(String(error).includes('private invalid contents'), false)
          return true
        })
      }
    }
    const tiff = await raster().tiff().toBuffer()
    await assert.rejects(prepareImage(tiff, 'image/avif', store.imageLimits, signal()), /contents do not match/)
    await assert.rejects(prepareImage(tiff.subarray(0, 16), 'image/tiff', store.imageLimits, signal()), /Unable to decode/)
  })
})

test('multi-page TIFF is refused instead of silently discarding pages', async () => {
  await withStore(async store => {
    const data = await sharp({ create: { width: 2, height: 6, pageHeight: 3, channels: 3, background: 'red' } }).tiff().toBuffer()
    assert.equal((await sharp(data).metadata()).pages, 2)
    await assert.rejects(prepareImage(data, 'image/tiff', store.imageLimits, signal()), /Multi-page TIFF/)
  })
})

test('pixel, dimension, output byte and deployment media-type limits apply to conversion', async () => {
  await withStore(async store => {
    const data = await raster().tiff().toBuffer()
    for (const [limits, pattern] of [
      [{ ...store.imageLimits, maxImagePixels: 5 }, /Unable to decode|pixel/],
      [{ ...store.imageLimits, maxImageDimension: 2 }, /dimension limits/],
      [{ ...store.imageLimits, maxImageBytes: 1 }, /Converted image exceeds/],
      [{ ...store.imageLimits, mediaTypes: ['image/jpeg'] as const }, /requires PNG/],
    ] as const) await assert.rejects(prepareImage(data, 'image/tiff', limits, signal()), pattern)
  })
})

test('source byte, aggregate byte and count limits include additional image types', async () => {
  await withStore(async (store, images) => {
    const data = await raster().avif().toBuffer()
    const file = await stage(images, data, 'image/avif')
    for (const limits of [
      { ...store.imageLimits, maxImageBytes: data.length - 1 },
      { ...store.imageLimits, maxMessageImageBytes: data.length - 1 },
      { ...store.imageLimits, maxImagesPerMessage: 0 },
    ]) {
      const limited = Object.create(store) as LocalAttachmentStore
      Object.defineProperty(limited, 'imageLimits', { value: limits })
      await assert.rejects(images.prepare([file], limited, signal()), /size or count limits/)
    }
  })
})

test('converted bytes are counted with native images against the aggregate limit', async () => {
  await withStore(async (store, images) => {
    // Deterministic noise yields a small lossy AVIF whose lossless PNG expands substantially.
    const pixels = Buffer.alloc(128 * 128 * 3)
    let state = 1
    for (let index = 0; index < pixels.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      pixels[index] = state & 255
    }
    const data = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).avif({ quality: 30 }).toBuffer()
    const converted = await prepareImage(data, 'image/avif', store.imageLimits, signal())
    assert.ok(converted.data.length > data.length)
    const png = await raster().png().toBuffer()
    const files = [await stage(images, png, 'image/png'), await stage(images, data, 'image/avif')]
    const limited = Object.create(store) as LocalAttachmentStore
    Object.defineProperty(limited, 'imageLimits', { value: { ...store.imageLimits,
      maxMessageImageBytes: png.length + data.length } })
    await assert.rejects(images.prepare(files, limited, signal()), /aggregate image-byte limit/)
  })
})

test('conversion verifies the original checksum and honors cancellation', async () => {
  await withStore(async (store, images) => {
    const data = await raster().tiff().toBuffer()
    const file = await stage(images, data, 'image/tiff')
    await assert.rejects(images.prepare([{ ...file, sha256: '0'.repeat(64) }], store, signal()), /content does not match/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(images.prepare([file], store, controller.signal), { name: 'AbortError' })
    await assert.rejects(prepareImage(data, 'image/tiff', store.imageLimits, controller.signal), { name: 'AbortError' })
  })
})

test('image-only capability advertises convertible formats without promising HEIC, HEIF or SVG decoding', () => {
  const imageOnly = capabilities(undefined, true, false, { attachments: true })
    .capabilities.find(item => item.capabilityId === 'runtime.attachment')!
  for (const mediaType of ['image/avif', 'image/tiff']) {
    assert.equal(isImageInputType(mediaType), true)
    assert.ok(imageOnly.metadata!.allowedMimeTypes!.some(type => type === mediaType))
  }
  for (const mediaType of ['image/heic', 'image/heif', 'image/svg+xml', 'application/pdf']) {
    assert.equal(isImageInputType(mediaType), false)
  }
  assert.equal(capabilities(undefined, true, false, { attachments: true, files: true })
    .capabilities.find(item => item.capabilityId === 'runtime.attachment')!.metadata, undefined)
})
