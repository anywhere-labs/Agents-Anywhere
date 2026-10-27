import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveUv, withPackageIndexes } from '../../src/host/connector/environment.js'
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

test('the chosen PyPI mirror comes first and the official PyPI is the fallback', () => {
  const inherited = { PATH: '/bin', UV_INDEX: 'https://inherited.example/simple', UV_DEFAULT_INDEX: 'https://inherited.example/simple' }
  const pypi = 'https://pypi.org/simple'
  // TUNA carries no openai-codex: uv resolves it from the PyPI fallback.
  assert.deepEqual(withPackageIndexes(inherited, 'https://pypi.tuna.tsinghua.edu.cn/simple/'), {
    PATH: '/bin', UV_DEFAULT_INDEX: pypi, UV_INDEX_URL: pypi,
    UV_INDEX: 'https://pypi.tuna.tsinghua.edu.cn/simple', PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  })
  for (const official of ['', 'https://pypi.org/simple/']) {
    const environment = withPackageIndexes(inherited, official)
    assert.equal('UV_INDEX' in environment, false, `${official || 'default'} drops an inherited UV_INDEX`)
    assert.deepEqual(environment, { PATH: '/bin', UV_DEFAULT_INDEX: pypi, UV_INDEX_URL: pypi, PIP_INDEX_URL: pypi })
  }
})
