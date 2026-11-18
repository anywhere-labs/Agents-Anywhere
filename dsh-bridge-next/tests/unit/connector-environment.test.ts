import assert from 'node:assert/strict'
import test from 'node:test'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureExecutable, launchDetached, removePythonEnvironment, resolveConnectorLaunch } from '../../src/host/connector/environment.js'

const config = (root: string) => ({ stateRoot: join(root, 'state'), connectorDir: join(root, 'bundle'), connectorDataDir: join(root, 'v3'), apiBaseUrl: 'https://example.test' })
const host = (overrides: Partial<{ execPath: string, platform: NodeJS.Platform, arch: string, electron: boolean, env: NodeJS.ProcessEnv }> = {}) =>
  ({ execPath: '/opt/node/bin/node', platform: 'linux' as NodeJS.Platform, arch: 'x64', electron: false, env: {}, ...overrides })

async function bundle(root: string, targets: string[]) {
  await mkdir(join(root, 'bundle', 'assets'), { recursive: true })
  await writeFile(join(root, 'bundle', 'anywhere-cli.js'), '')
  for (const target of targets) {
    await mkdir(join(root, 'bundle', 'router', target), { recursive: true })
    await writeFile(join(root, 'bundle', 'router', target, target.startsWith('win32') ? 'meshcall-router.exe' : 'meshcall-router'), '', { mode: 0o755 })
  }
}

test('the bundled Connector runs on the host\'s Node with the Router of its platform', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await bundle(root, ['linux-x64', 'darwin-arm64'])
  const launch = await resolveConnectorLaunch(config(root), '/state/connector/connector.json', host())
  assert.deepEqual(launch, {
    command: '/opt/node/bin/node',
    args: [join(root, 'bundle', 'anywhere-cli.js'), 'rpc', '--config', '/state/connector/connector.json'],
    env: {}, router: join(root, 'bundle', 'router', 'linux-x64', 'meshcall-router'),
  })
  const arm = await resolveConnectorLaunch(config(root), '/c.json', host({ platform: 'darwin', arch: 'arm64' }))
  assert.equal(arm.router, join(root, 'bundle', 'router', 'darwin-arm64', 'meshcall-router'))
  assert.equal((await resolveConnectorLaunch(config(root), '/c.json', host({ env: { MESHCALL_ROUTER_BINARY: '/dev/router' } }))).router, '/dev/router')
  await assert.rejects(resolveConnectorLaunch(config(root), '/c.json', host({ platform: 'win32', arch: 'arm64' })), /不支持这台电脑的平台（win32-arm64）/)
  await rm(join(root, 'bundle', 'anywhere-cli.js'))
  await assert.rejects(resolveConnectorLaunch(config(root), '/c.json', host()), /未找到内置 Connector/)
})

test('under DSH Desktop the Connector runs on Electron as Node, without leaking that to its own commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-launch-electron-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await bundle(root, ['darwin-arm64'])
  const electron = '/Applications/DSH.app/Contents/MacOS/DSH'
  const launch = await resolveConnectorLaunch(config(root), '/c.json', host({ execPath: electron, platform: 'darwin', arch: 'arm64', electron: true }))
  assert.equal(launch.command, electron)
  assert.deepEqual(launch.args, ['--import', pathToFileURL(join(root, 'bundle', 'assets', 'electron-node.mjs')).href,
    join(root, 'bundle', 'anywhere-cli.js'), 'rpc', '--config', '/c.json'])
  assert.deepEqual(launch.env, { ELECTRON_RUN_AS_NODE: '1', AA_ELECTRON_NODE: electron })
})

test('the Python Connector\'s environment is removed from the plugin data directory, and nothing else', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-python-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of [['connector-venv', 'bin', 'python'], ['connector-source', 'abc', 'uv.lock'], ['bin', 'uv'], ['bin', 'meshcall-router'], ['connector', 'connector.json']]) {
    await mkdir(join(root, ...path.slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...path), '')
  }
  await removePythonEnvironment(root)
  await removePythonEnvironment(root)
  assert.deepEqual([existsSync(join(root, 'connector-venv')), existsSync(join(root, 'connector-source')), existsSync(join(root, 'bin', 'uv'))], [false, false, false])
  assert.equal(existsSync(join(root, 'bin', 'meshcall-router')), true)
  assert.equal(existsSync(join(root, 'connector', 'connector.json')), true)
})

test('a bundled binary without its executable bit is repaired, or copied when it cannot be', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-exec-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = async (path: string) => { await access(path, constants.X_OK); return path }
  const unpacked = join(root, 'meshcall-router')
  await writeFile(unpacked, '#!/bin/sh\n', { mode: 0o644 })
  assert.equal(await executable(await ensureExecutable(unpacked, join(root, 'bin'))), unpacked)
  // Already executable: left alone, and its mode is not touched.
  assert.equal(await ensureExecutable(unpacked, join(root, 'bin'), async () => { throw new Error('unexpected') }), unpacked)

  const readOnly = join(root, 'readonly-router')
  await writeFile(readOnly, '#!/bin/sh\necho copy\n', { mode: 0o644 })
  const copied = await ensureExecutable(readOnly, join(root, 'bin'), async () => { throw new Error('EPERM') })
  assert.equal(copied, join(root, 'bin', 'readonly-router'))
  await executable(copied)
  assert.equal(await readFile(copied, 'utf8'), await readFile(readOnly, 'utf8'))

  await assert.rejects(ensureExecutable(join(root, 'missing'), join(root, 'bin')))
})

test('folder openers launched detached succeed regardless of their exit code', async () => {
  // explorer.exe exits with code 1 after handing the folder to the running shell.
  await launchDetached(process.execPath, ['-e', 'process.exit(1)'])
  await assert.rejects(launchDetached(join(tmpdir(), 'missing-file-manager-binary'), []))
})
