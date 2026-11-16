import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { shippedRouterBinary } from '../../src/host/local-hub.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the Router a packaged build ships', () => {
  it('is found in router/ next to the bundle, and absent when running from source', () => {
    const dist = mkdtempSync(join(tmpdir(), 'aa-dist-'))
    dirs.push(dist)
    const bundle = pathToFileURL(join(dist, 'anywhere-cli.js'))
    expect(shippedRouterBinary(bundle)).toBeUndefined()
    mkdirSync(join(dist, 'router'))
    const binary = join(dist, 'router', process.platform === 'win32' ? 'meshcall-router.exe' : 'meshcall-router')
    writeFileSync(binary, '')
    expect(shippedRouterBinary(bundle)).toBe(binary)
    expect(shippedRouterBinary()).toBeUndefined()
  })
})
