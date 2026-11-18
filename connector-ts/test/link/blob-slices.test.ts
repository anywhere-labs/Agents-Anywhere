import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { blobSlices, type LocalBlob } from '../../src/link/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function file(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'aa-slices-'))
  dirs.push(dir)
  const path = join(dir, 'photo.png')
  writeFileSync(path, bytes)
  return path
}

describe('blobSlices', () => {
  it('reads the requested range of what the lookup finds, clipped to its size', async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
    const blob: LocalBlob = { path: file(bytes), name: 'photo.png', mediaType: 'image/png', size: bytes.length, sha256: 'x' }
    const asked: string[] = []
    const read = blobSlices(async (sessionId, blobRef) => {
      asked.push(`${sessionId}/${blobRef}`)
      return blobRef === 'file_1' ? blob : null
    })
    expect(await read('s1', 'file_2', 0, 10)).toBeNull()
    const head = await read('s1', 'file_1', 0, 300)
    expect(head).toMatchObject({ name: 'photo.png', mediaType: 'image/png', size: 1000 })
    expect(Buffer.from(head!.bytes)).toEqual(bytes.subarray(0, 300))
    const tail = await read('s1', 'file_1', 900, 300)
    expect(Buffer.from(tail!.bytes)).toEqual(bytes.subarray(900))
    expect((await read('s1', 'file_1', 1000, 300))!.bytes.length).toBe(0)
    expect(asked).toEqual(['s1/file_2', 's1/file_1', 's1/file_1', 's1/file_1'])
  })
})
