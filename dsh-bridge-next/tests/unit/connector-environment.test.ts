import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveUv } from '../../src/host/connector/environment.js'
import { DEFAULT_CONNECTOR_SETTINGS } from '../../src/contracts/connector.js'

const config = { stateRoot: '/unused', connectorSourceDir: '/unused', uvPath: 'uv', apiBaseUrl: 'https://example.test' }
test('npm uv resolves its native optional dependency with install scripts disabled', async () => {
  const binary = await resolveUv(config, DEFAULT_CONNECTOR_SETTINGS)
  assert.ok(binary)
  // There is no committed lockfile and the linker layout is not part of the contract:
  // with install scripts disabled the platform optional package may be resolved directly
  // or through the package's bin shim. What matters is that the plugin runs the uv
  // bundled with the npm dependency instead of an arbitrary uv from the system PATH.
  const nodeModules = `${resolve(fileURLToPath(new URL('../../node_modules', import.meta.url)))}${sep}`
  assert.ok(resolve(binary).startsWith(nodeModules), `expected a bundled uv under ${nodeModules}, got ${binary}`)
  const { stdout } = await promisify(execFile)(binary, ['--version'], { timeout: 10_000 })
  assert.match(stdout, /^uv 0\.12\.0\b/)
})
test('explicit uv overrides take priority over the npm dependency', async () => {
  assert.equal(await resolveUv(config, { ...DEFAULT_CONNECTOR_SETTINGS, uvPath: process.execPath }), process.execPath)
  assert.equal(await resolveUv({ ...config, uvPath: process.execPath }, DEFAULT_CONNECTOR_SETTINGS), process.execPath)
})
