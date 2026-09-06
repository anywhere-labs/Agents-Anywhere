/**
 * Unit tests for the four-tier uv resolver.
 *
 * The tests build a minimal in-process fixture:
 * - `createFakeUvExecutable()` writes a tiny POSIX shell script that exits 0
 *   and prints a fake version; chmod 0o755 makes it executable.
 * - `withEnvVar(name, value)` and `withCwd(dir)` temporarily mutate process
 *   state so the resolver sees a controlled environment.
 *
 * We mock `child_process.execFileSync` so the tests don't reach the host
 * shell or accidentally inherit a real `uv` from the dev machine.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvDetector } from '../src/manager/env-detector.js'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync: vi.fn(),
  }
})

const execFileSyncMock = vi.mocked(execFileSync)

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'env-detector-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function createFakeUvExecutable(dir: string, version = 'uv 0.6.14'): string {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'uv')
  // POSIX shell script — exit 0 + print version to stdout.
  writeFileSync(script, `#!/usr/bin/env sh\necho "${version}"\nexit 0\n`)
  chmodSync(script, 0o755)
  return script
}

function createFakeBundle(dir: string, version = 'uv 0.6.14'): string {
  const packageRoot = join(dir, 'node_modules', '@agents-anywhere', 'uv-darwin-arm64')
  const binDir = join(packageRoot, 'bin')
  mkdirSync(binDir, { recursive: true })
  const script = join(binDir, 'uv')
  writeFileSync(script, `#!/usr/bin/env sh\necho "${version}"\nexit 0\n`)
  chmodSync(script, 0o755)
  return script
}

interface ExecCall {
  cmd: string
  args: ReadonlyArray<string>
}

let execPlan: (call: ExecCall) => Buffer | null = () => null
let lastExec: ExecCall | null = null

beforeEach(() => {
  lastExec = null
  execPlan = (call) => {
    lastExec = call
    return null
  }
  execFileSyncMock.mockImplementation(((cmd: string, args: ReadonlyArray<string> | string = []) => {
    const normalizedArgs = Array.isArray(args) ? args : [args]
    const result = execPlan({ cmd, args: normalizedArgs })
    if (result === null) throw new Error(`unexpected exec: ${cmd} ${normalizedArgs.join(' ')}`)
    return result
  }) as never)
})

afterEach(() => {
  execFileSyncMock.mockReset()
})

describe('EnvDetector', () => {
  it('honors a valid explicit customPath above every other tier', () => {
    withTempDir((dir) => {
      const fake = createFakeUvExecutable(dir)
      execPlan = () => Buffer.from('uv 0.6.14\n')
      const result = new EnvDetector({
        homeDir: '/nonexistent',
        platform: 'darwin',
        arch: 'arm64',
        customPath: fake,
        env: {},
      }).resolve()
      expect(result.source).toBe('custom')
      expect(result.uvPath).toBe(fake)
      expect(result.executable).toBe(true)
      expect(result.version).toBe('uv 0.6.14')
    })
  })

  it('falls through to system PATH when the explicit path is missing', () => {
    withTempDir((dir) => {
      const systemUv = createFakeUvExecutable(dir, 'uv 0.5.0')
      execPlan = (call) => {
        if (call.cmd === 'which') return Buffer.from(`${systemUv}\n`)
        return Buffer.from('uv 0.5.0\n')
      }
      const result = new EnvDetector({
        homeDir: '/nonexistent',
        platform: 'darwin',
        arch: 'arm64',
        env: {},
      }).resolve()
      expect(result.source).toBe('system')
      expect(result.uvPath).toBe(systemUv)
      expect(result.executable).toBe(true)
      expect(result.version).toBe('uv 0.5.0')
    })
  })

  it('uses the NPM-bundled binary when PATH lookup misses', () => {
    withTempDir((dir) => {
      const bundleUv = createFakeBundle(dir, 'uv 0.6.14 (bundled)')
      // The detector normalizes the resolved path via realpath, so the
      // macOS `/private/var` symlink collapses to `/var` before comparison.
      const { realpathSync } = require('node:fs') as typeof import('node:fs')
      const expectedPath = realpathSync(bundleUv)
      execPlan = () => Buffer.from('uv 0.6.14 (bundled)\n')
      const result = new EnvDetector({
        homeDir: '/nonexistent',
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        bundleRoot: dir,
      }).resolve()
      expect(result.source).toBe('npm-bundled')
      expect(result.uvPath).toBe(expectedPath)
      expect(result.executable).toBe(true)
      expect(result.version).toBe('uv 0.6.14 (bundled)')
    })
  })

  it('falls back to a previously downloaded uv in the home directory', () => {
    withTempDir((dir) => {
      const home = join(dir, 'home')
      const downloadUv = createFakeUvExecutable(join(home, '.agents-anywhere', 'bin'), 'uv 0.7.1 (downloaded)')
      // No PATH match, no bundle — use the downloaded uv.
      execPlan = (call) => {
        if (call.cmd === 'which') throw new Error('no system uv')
        return Buffer.from('uv 0.7.1 (downloaded)\n')
      }
      const result = new EnvDetector({
        homeDir: home,
        platform: 'darwin',
        arch: 'arm64',
        env: {},
      }).resolve()
      expect(result.source).toBe('downloaded')
      expect(result.uvPath).toBe(downloadUv)
      expect(result.executable).toBe(true)
      expect(result.version).toBe('uv 0.7.1 (downloaded)')
    })
  })

  it('returns unresolved when every tier misses', () => {
    execPlan = () => {
      throw new Error('no uv anywhere')
    }
    const result = new EnvDetector({
      homeDir: '/nonexistent',
      platform: 'darwin',
      arch: 'arm64',
      env: {},
    }).resolve()
    expect(result.source).toBe('unresolved')
    expect(result.uvPath).toBeNull()
    expect(result.executable).toBe(false)
    expect(result.notes.length).toBeGreaterThan(0)
  })

  it('prefers customPath over UV_PATH env var when both are set', () => {
    withTempDir((dir) => {
      const fake = createFakeUvExecutable(dir)
      execPlan = () => Buffer.from('uv 0.6.14\n')
      const result = new EnvDetector({
        homeDir: '/nonexistent',
        platform: 'darwin',
        arch: 'arm64',
        customPath: fake,
        env: { UV_PATH: '/should/not/be/used' },
      }).resolve()
      expect(result.source).toBe('custom')
      expect(result.uvPath).toBe(fake)
    })
  })

  it('treats a customPath that points at a non-existent file as a miss', () => {
    execPlan = () => {
      throw new Error('no uv')
    }
    const result = new EnvDetector({
      homeDir: '/nonexistent',
      platform: 'darwin',
      arch: 'arm64',
      customPath: '/definitely/not/a/real/path/uv',
      env: {},
    }).resolve()
    expect(result.source).toBe('unresolved')
    expect(result.notes.some((n) => n.includes('UV_PATH not found'))).toBe(true)
  })

  it('marks a non-executable customPath as un-runnable and keeps falling through', () => {
    withTempDir((dir) => {
      const fake = join(dir, 'uv')
      writeFileSync(fake, '#!/usr/bin/env sh\necho broken\nexit 1\n')
      // Make it not executable (chmod 0o644). readVersion will fail; the tier is
      // skipped and the resolver keeps walking.
      chmodSync(fake, 0o644)
      execPlan = () => {
        throw new Error('which uv should fail')
      }
      const result = new EnvDetector({
        homeDir: '/nonexistent',
        platform: 'darwin',
        arch: 'arm64',
        customPath: fake,
        env: {},
      }).resolve()
      expect(result.source).toBe('unresolved')
    })
  })
})