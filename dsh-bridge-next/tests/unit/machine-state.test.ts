import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import desktopMachine from '../../../desktop-workbench/electron/machine-state.ts'
import { machineStatePath, readLocalConnectorIds, readMachineState } from '../../src/host/desktop/machine-state.js'
import { recordConnectorId, launchConnector } from '../helpers/python-connector.js'

const { MachineStateStore, desktopInstallation } = desktopMachine
const installation = (home: string) => desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform })

test('hosts read the history written by Python without changing order or file contents', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-python-history-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await recordConnectorId(home, 'first')
  await recordConnectorId(home, 'second')
  await recordConnectorId(home, 'first')
  const file = machineStatePath(home), before = await readFile(file, 'utf8')
  assert.deepEqual(await readLocalConnectorIds(home), ['first', 'second'])
  assert.deepEqual(new MachineStateStore(file).readConnectorIds(), ['first', 'second'])
  assert.equal(await readFile(file, 'utf8'), before)
  assert.doesNotMatch(before, /fixture|connectorToken|accessToken/)
})

test('Desktop installation updates preserve a live Python Connector owner and history', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-install-owner-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const connector = launchConnector(home, 'cli')
  t.after(() => connector.close())
  await connector.request('connector.start', { serverUrl: 'https://example.test', connectorId: 'live', connectorToken: 'fixture' })
  const before = await readMachineState(home)
  await new MachineStateStore(machineStatePath(home)).recordInstallation(installation(home))
  const after = await readMachineState(home)
  assert.deepEqual(after.runtime, before.runtime)
  assert.deepEqual(after.connectorIds, ['live'])
  assert.equal((after.desktop as any).executablePath, process.execPath)
})

test('Desktop installation and Python ID publication serialize without losing either field', { timeout: 20000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-writers-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const desktop = new MachineStateStore(machineStatePath(home))
  await Promise.all([
    (async () => { for (let i = 0; i < 8; i++) await desktop.recordInstallation(installation(home)) })(),
    (async () => { for (let i = 0; i < 8; i++) await recordConnectorId(home, `python-${i}`) })(),
  ])
  const state = await readMachineState(home)
  assert.deepEqual(state.connectorIds, Array.from({ length: 8 }, (_, i) => `python-${i}`))
  assert.equal((state.desktop as any).appPath, await realpath(home))
})

test('read-only discovery leaves legacy migration to Python and preserves unknown fields', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-migrate-state-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const legacy = join(home, '.agentsanywhere', 'machine.json')
  await mkdir(dirname(legacy), { recursive: true })
  const contents = JSON.stringify({ version: 1, connectorIds: ['legacy'], future: true })
  await writeFile(legacy, contents)
  assert.deepEqual(await readLocalConnectorIds(home), ['legacy'])
  assert.equal(await readFile(legacy, 'utf8'), contents)
  await new MachineStateStore(machineStatePath(home)).recordInstallation(installation(home))
  await recordConnectorId(home, 'current')
  const state = await readMachineState(home)
  assert.deepEqual(state.connectorIds, ['legacy', 'current'])
  assert.equal(state.future, true)
  assert.equal((state.desktop as any).appPath, await realpath(home))
  await assert.rejects(readFile(legacy), { code: 'ENOENT' })
})
