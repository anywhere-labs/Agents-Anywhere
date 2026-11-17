import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Updater, canonical, newer, verifyManifest, type ReleaseManifest } from '../../src/host/index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-upd-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function keyPair(): { publicKey: string; signManifest: (m: Omit<ReleaseManifest, 'signature'>) => ReleaseManifest } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')
  return {
    publicKey: raw,
    signManifest: m => ({ ...m, signature: sign(null, Buffer.from(canonical(m)), privateKey).toString('base64') }),
  }
}

function packageFor(version: string): Buffer {
  const build = join(dir, 'build')
  mkdirSync(join(build, `anywhere-cli-${version}`, 'bin'), { recursive: true })
  writeFileSync(join(build, `anywhere-cli-${version}`, 'VERSION'), version)
  execFileSync('tar', ['-czf', join(build, 'pkg.tgz'), '-C', build, `anywhere-cli-${version}`])
  return readFileSync(join(build, 'pkg.tgz'))
}

describe('signed releases', () => {
  it('verifies the Ed25519 signature over canonical JSON', () => {
    const keys = keyPair()
    const manifest = keys.signManifest({ version: '3.1.0', files: { 'darwin-arm64': { name: 'a.tgz', sha256: 'x', size: 1 } } })
    expect(verifyManifest(manifest, [keys.publicKey])).toBe(true)
    expect(verifyManifest({ ...manifest, version: '9.9.9' }, [keys.publicKey])).toBe(false)
    expect(verifyManifest(manifest, [keyPair().publicKey])).toBe(false)
    expect(verifyManifest({ ...manifest, signature: '' }, [keys.publicKey])).toBe(false)
    expect(canonical({ b: 1, a: [true, { d: null, c: 'x' }] })).toBe('{"a":[true,{"c":"x","d":null}],"b":1}')
  })

  it('compares versions', () => {
    expect(newer('3.10.0', '3.9.3')).toBe(true)
    expect(newer('3.0.0', '3.0.0')).toBe(false)
    expect(newer('3.0.1-rc.2', '3.0.1-rc.1')).toBe(true)
  })

  it('stages a verified release and refuses bad, unsigned, older or unmanaged ones', async () => {
    const keys = keyPair()
    const data = packageFor('3.1.0')
    const file = { name: 'anywhere-cli-3.1.0-darwin-arm64.tgz', sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
    let release: ReleaseManifest | null = keys.signManifest({ version: '3.1.0', files: { 'darwin-arm64': file } })
    const app = join(dir, 'app')
    mkdirSync(app)
    const updater = new Updater({
      version: '3.0.0', appRoot: app, keys: [keys.publicKey], target: 'darwin-arm64',
      fetchRelease: async () => release, download: async () => data,
      idle: () => true, restart: () => undefined, log: () => undefined,
    })
    expect(await updater.check()).toBe('3.1.0')
    expect(readFileSync(join(app, 'pending'), 'utf8')).toBe('3.1.0\n')
    expect(readFileSync(join(app, 'versions', '3.1.0', 'VERSION'), 'utf8')).toBe('3.1.0')
    expect(existsSync(join(app, '.download-3.1.0'))).toBe(false)

    release = keys.signManifest({ version: '3.2.0', files: { 'darwin-arm64': { ...file, sha256: '0'.repeat(64) } } })
    await expect(updater.check()).rejects.toThrow(/checksum/u)
    release = { ...keys.signManifest({ version: '3.3.0', files: { 'darwin-arm64': file } }), version: '3.4.0' }
    expect(await updater.check()).toBeUndefined()
    release = keys.signManifest({ version: '2.9.0', files: { 'darwin-arm64': file } })
    expect(await updater.check()).toBeUndefined()
    expect(await new Updater({ version: '3.0.0', appRoot: undefined, keys: [keys.publicKey], fetchRelease: async () => release, download: async () => data, idle: () => true, restart: () => undefined, log: () => undefined }).check()).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('launcher.sh', () => {
  it('switches to the staged version on exit 75 and stops on exit 0', () => {
    const app = join(dir, 'app')
    const launcher = join(app, 'launcher.sh')
    mkdirSync(app)
    writeFileSync(launcher, readFileSync(join(import.meta.dirname, '../../installer/launcher.sh')))
    chmodSync(launcher, 0o755)
    for (const [version, body] of [['3.0.0', `echo 3.1.0 > "$AA_CONNECTOR_APP_ROOT/pending"; exit 75`], ['3.1.0', 'echo "running 3.1.0 $1"; exit 0']] as const) {
      mkdirSync(join(app, 'versions', version, 'bin'), { recursive: true })
      writeFileSync(join(app, 'versions', version, 'VERSION'), version)
      writeFileSync(join(app, 'versions', version, 'bin', 'anywhere-cli'), `#!/bin/sh\n${body}\n`)
      chmodSync(join(app, 'versions', version, 'bin', 'anywhere-cli'), 0o755)
    }
    symlinkSync('versions/3.0.0', join(app, 'current'))
    const result = spawnSync(launcher, ['start'], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('launcher: switched to 3.1.0')
    expect(result.stdout).toContain('running 3.1.0 start')
    expect(readlinkSync(join(app, 'current'))).toBe('versions/3.1.0')
    expect(readFileSync(join(app, 'previous'), 'utf8').trim()).toBe('versions/3.0.0')
  })
})
