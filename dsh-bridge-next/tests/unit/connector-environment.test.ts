import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveUv } from '../../src/host/connector/environment.js'
import { connectorEnvironment } from '../../src/host/connector/process.js'
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

test('Connector 环境记录插件注入的工具链变量原值，供 Connector 启动终端和 Runtime 时恢复', () => {
  const environment = connectorEnvironment({
    AA_CONNECTOR_OWNER_KIND: 'dsh-plugin',
    UV_PROJECT_ENVIRONMENT: '/data/connector-venv',
    UV_INDEX_URL: 'https://pypi.org/simple',
    PIP_INDEX_URL: 'https://same.example/simple',
  }, {
    PATH: '/usr/bin',
    UV_INDEX_URL: 'https://mirror.example/simple',
    PIP_INDEX_URL: 'https://same.example/simple',
  })
  assert.deepEqual(JSON.parse(environment['AA_CONNECTOR_INJECTED_ENV']!), {
    UV_PROJECT_ENVIRONMENT: null,
    UV_INDEX_URL: 'https://mirror.example/simple',
  })
  assert.equal(environment['PATH'], '/usr/bin')
  assert.equal(environment['UV_INDEX_URL'], 'https://pypi.org/simple')
})
