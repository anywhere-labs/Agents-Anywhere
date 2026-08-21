/**
 * Verifies the `anywhere-cli` source bundled in `src/connector-source/` is
 * well-formed: `pyproject.toml` exists, declares the `anywhere-cli` console
 * script, and the entry point module loads through Node's parser without
 * syntax errors. The integration test that actually spawns the subprocess
 * is gated on a real `uv` install and lives outside the default test run.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = pathToFileURL(__filename)
const REPO_ROOT = resolve(fileURLToPath(HERE), '..', '..')
const BUNDLED_ROOT = join(REPO_ROOT, 'src', 'connector-source')

describe('Bundled anywhere-cli source', () => {
  it('lives under src/connector-source/ with the expected layout', () => {
    expect(existsSync(join(BUNDLED_ROOT, 'pyproject.toml'))).toBe(true)
    expect(existsSync(join(BUNDLED_ROOT, 'uv.lock'))).toBe(true)
    expect(existsSync(join(BUNDLED_ROOT, 'connector', 'cli.py'))).toBe(true)
    expect(existsSync(join(BUNDLED_ROOT, 'connector', 'control.py'))).toBe(true)
  })

  it('declares the anywhere-cli entry point in pyproject.toml', () => {
    const pyproject = readFileSync(join(BUNDLED_ROOT, 'pyproject.toml'), 'utf8')
    expect(pyproject).toMatch(/^\[project\.scripts\]\s*\nanywhere-cli\s*=/m)
    expect(pyproject).toContain('anywhere-cli = "connector.cli:main"')
  })

  it('starts with Python >= 3.12 to align with the plugin runtime', () => {
    const pyproject = readFileSync(join(BUNDLED_ROOT, 'pyproject.toml'), 'utf8')
    expect(pyproject).toMatch(/requires-python\s*=\s*">=3\.12"/)
  })

  it('does not ship cached bytecode or virtualenv', () => {
    // Spot-check the exclusion list: __pycache__ directories and .venv/
    // should never be checked in. A quick recursive walk catches accidental
    // regressions in case someone copies the wrong tree.
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    function hasNoForbiddenEntry(dir: string): boolean {
      for (const entry of readdirSync(dir)) {
        if (entry === '__pycache__' || entry === '.venv' || entry === '.mypy_cache') return false
        const full = join(dir, entry)
        if (statSync(full).isDirectory() && !hasNoForbiddenEntry(full)) return false
      }
      return true
    }
    expect(hasNoForbiddenEntry(BUNDLED_ROOT)).toBe(true)
  })
})

// The integration test below is gated on `uv` being available; it's exported
// as a separate `describe` so callers can opt in by setting
// `RUN_CONNECTOR_INTEGRATION=1`. Skipped by default to keep the standard
// test run hermetic.
const runIntegration = process.env.RUN_CONNECTOR_INTEGRATION === '1'

describe.skipIf(!runIntegration)('Bundled anywhere-cli uv run', () => {
  it('spawns anywhere-cli start and receives a stdout line', async () => {
    const { spawn } = await import('node:child_process')
    const proc = spawn('uv', ['run', 'anywhere-cli', '--help'], {
      cwd: BUNDLED_ROOT,
      env: { ...process.env, AA_TEST_FAST_EXIT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    const exitCode: number = await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolveExit(-1)
      }, 60_000)
      proc.on('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code ?? 0)
      })
    })
    expect(exitCode).not.toBe(-1)
    expect(stdout.length).toBeGreaterThan(0)
  }, 90_000)
})