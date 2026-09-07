import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import desktopState from '../../../desktop-workbench/electron/machine-state.ts'
import { machineStatePath, readLocalConnectorIds, recordLocalConnectorId } from '../../src/host/desktop/machine-state.js'
import { withMachineStateLock } from '../../src/host/desktop/machine-state-lock.js'
import { detectDesktop } from '../../src/host/desktop/detect.js'

const { MachineStateStore, desktopInstallation, machineStatePath: desktopMachinePath } = desktopState

test('real Desktop writer and plugin reader share the same path, install record and ordered IDs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-contract-中文 '))
  const path = machineStatePath(home)
  try {
    assert.equal(path, desktopMachinePath(home))
    assert.deepEqual(await readLocalConnectorIds(home), [])
    const writer = new MachineStateStore(path)
    await writer.recordConnectorId('conn-second-on-server')
    await writer.recordConnectorId('conn-first-on-server')
    await writer.recordConnectorId('conn-second-on-server')
    assert.equal((await detectDesktop(home)).status, 'absent')
    await writer.recordInstallation(desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform }))
    const before = await stat(path)
    assert.equal((await detectDesktop(home)).status, 'installed')
    assert.deepEqual(await readLocalConnectorIds(home), ['conn-second-on-server', 'conn-first-on-server'])
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
    await writeFile(path, JSON.stringify({ version: 2, connectorIds: ['conn-history'], desktop: { platform: process.platform, executablePath: join(home, 'removed-app') } }))
    assert.equal((await detectDesktop(home)).status, 'absent')
    assert.deepEqual(await readLocalConnectorIds(home), ['conn-history'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('unreadable or malformed machine state is not mistaken for an empty pairing history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-invalid-'))
  const writer = new MachineStateStore(machineStatePath(home))
  try {
    await writer.recordConnectorId('conn-test')
    for (const body of ['{bad', 'null', '{"version":3}', '{"version":1,"connectorIds":[42]}']) {
      await writeFile(writer.filePath, body)
      await assert.rejects(readLocalConnectorIds(home))
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('plugin publishes IDs before Desktop is installed and preserves installation and future fields', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-plugin-writer-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = machineStatePath(home)
  await recordLocalConnectorId('plugin-first', home)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2, connectorIds: ['plugin-first'], legacyMachineMigrated: true })
  assert.equal((await detectDesktop(home)).status, 'absent')
  const writer = new MachineStateStore(path)
  const installation = desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform })
  await writer.recordInstallation(installation)
  const existing = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...existing, future: { keep: true } }))
  await recordLocalConnectorId('plugin-second', home)
  const snapshot = await readFile(path, 'utf8')
  const before = await stat(path)
  await recordLocalConnectorId(' plugin-second ', home)
  assert.equal(await readFile(path, 'utf8'), snapshot)
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
  assert.deepEqual(JSON.parse(snapshot), { ...existing, future: { keep: true }, connectorIds: ['plugin-first', 'plugin-second'] })
  if (process.platform !== 'win32') assert.equal(before.mode & 0o777, 0o600)
  assert.equal((await detectDesktop(home)).status, 'installed')
})

test('plugin refuses to overwrite invalid shared history', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-plugin-invalid-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await recordLocalConnectorId('known', home)
  for (const contents of ['{broken', 'null', '{"version":3}', '{"version":1,"connectorIds":[42]}']) {
    await writeFile(machineStatePath(home), contents)
    await assert.rejects(recordLocalConnectorId('new', home))
    assert.equal(await readFile(machineStatePath(home), 'utf8'), contents)
  }
})

test('Desktop waits for a plugin shared-record write before merging its ID', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-wait-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = machineStatePath(home)
  const desktop = new MachineStateStore(path)
  let desktopWrite: Promise<void> | undefined
  let completed = false
  await withMachineStateLock(path, async () => {
    desktopWrite = desktop.recordConnectorId('desktop').then(() => { completed = true })
    await delay(60)
    assert.equal(completed, false)
    await writeFile(path, JSON.stringify({ version: 2, connectorIds: ['plugin'] }))
  })
  await desktopWrite
  assert.deepEqual(await readLocalConnectorIds(home), ['plugin', 'desktop'])
})

test('concurrent Desktop and plugin processes preserve every ID and the installation', { timeout: 15_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-processes-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const desktopModule = new URL('../../../desktop-workbench/electron/machine-state.ts', import.meta.url).href
  const pluginModule = new URL('../../src/host/desktop/machine-state.ts', import.meta.url).href
  const scripts = [
    `import state from ${JSON.stringify(desktopModule)}; const home = process.argv[1]; const store = new state.MachineStateStore(state.machineStatePath(home)); for (let i = 0; i < 20; i++) { await store.recordInstallation(state.desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform })); await store.recordConnectorId('desktop-' + i); }`,
    `import { recordLocalConnectorId } from ${JSON.stringify(pluginModule)}; for (let i = 0; i < 20; i++) { await recordLocalConnectorId('plugin-' + i, process.argv[1]); await recordLocalConnectorId('plugin-' + i, process.argv[1]); }`,
  ]
  await Promise.all(scripts.map(script => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, home], { stdio: ['ignore', 'ignore', 'pipe'] })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer failed (${code}): ${stderr}`)))
  })))
  const ids = await readLocalConnectorIds(home)
  assert.equal(ids.length, 40)
  for (const prefix of ['desktop-', 'plugin-']) assert.deepEqual(ids.filter(id => id.startsWith(prefix)), Array.from({ length: 20 }, (_, i) => `${prefix}${i}`))
  assert.equal((await detectDesktop(home)).status, 'installed')
  assert.equal((await readdir(join(home, '.agentsanywhere'))).some(name => name.endsWith('.tmp')), false)
})

test('a crashed plugin writer releases its lease so Desktop can publish', { timeout: 8000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-crash-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = machineStatePath(home)
  const moduleUrl = new URL('../../src/host/desktop/machine-state-lock.ts', import.meta.url).href
  const script = `import { withMachineStateLock } from ${JSON.stringify(moduleUrl)}; await withMachineStateLock(process.argv[1], async () => { process.send('ready'); await new Promise(() => {}); });`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ended = once(child, 'exit')
  try {
    await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('writer exited before acquiring its lease') })])
    await assert.rejects(withMachineStateLock(path, () => assert.fail('must not acquire a held lease'), 40), /busy/)
    child.kill('SIGKILL')
    await ended
    await new MachineStateStore(path).recordConnectorId('after-crash')
    assert.deepEqual(await readLocalConnectorIds(home), ['after-crash'])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
  }
})
