import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import desktopState from '../../../desktop-workbench/electron/machine-state.ts'
import { machineStatePath, readLocalConnectorIds } from '../../src/host/desktop/machine-state.js'
import { detectDesktop } from '../../src/host/desktop/detect.js'

const { MachineStateStore, desktopInstallation, machineStatePath: desktopMachinePath } = desktopState

test('real Desktop writer and plugin reader share the same path, install record and ordered IDs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-contract-中文 '))
  const path = machineStatePath(home)
  try {
    assert.equal(path, desktopMachinePath(home))
    assert.deepEqual(await readLocalConnectorIds(home), [])
    const writer = new MachineStateStore(path)
    writer.recordConnectorId('conn-second-on-server')
    writer.recordConnectorId('conn-first-on-server')
    writer.recordConnectorId('conn-second-on-server')
    assert.equal((await detectDesktop(home)).status, 'absent')
    writer.recordInstallation(desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform }))
    const before = await stat(path)
    assert.equal((await detectDesktop(home)).status, 'installed')
    assert.deepEqual(await readLocalConnectorIds(home), ['conn-second-on-server', 'conn-first-on-server'])
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
    await writeFile(path, JSON.stringify({ version: 1, connectorIds: ['conn-history'], desktop: { platform: process.platform, executablePath: join(home, 'removed-app') } }))
    assert.equal((await detectDesktop(home)).status, 'absent')
    assert.deepEqual(await readLocalConnectorIds(home), ['conn-history'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('unreadable or malformed machine state is not mistaken for an empty pairing history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-machine-invalid-'))
  const writer = new MachineStateStore(machineStatePath(home))
  try {
    writer.recordConnectorId('conn-test')
    for (const body of ['{bad', 'null', '{"version":2}', '{"version":1,"connectorIds":[42]}']) {
      await writeFile(writer.filePath, body)
      await assert.rejects(readLocalConnectorIds(home))
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})
