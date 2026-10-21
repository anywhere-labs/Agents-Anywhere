import { machineStatePath } from '../../src/host/desktop/machine-state.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { acquireManagerLock, managerLockRecordPath, readJson, writeJson } from '../../src/host/storage/files.js'
import { desktopRecordPath, detectDesktop } from '../../src/host/desktop/detect.js'

test('private atomic state and singleton ownership are scoped to the configured data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-onboarding-'))
  try {
    const lock = join(root, 'manager.lock')
    const release = await acquireManagerLock(lock)
    await assert.rejects(acquireManagerLock(lock), /另一个插件实例/)
    await writeJson(join(root, 'nested', 'account.json'), { token: 'private-test-token' })
    assert.deepEqual(await readJson(join(root, 'nested', 'account.json')), { token: 'private-test-token' })
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'nested', 'account.json'))).mode & 0o777, 0o600)
    const held = await readJson<{ port: number, pid: number, token: string }>(managerLockRecordPath(lock))
    assert.equal(held?.pid, process.pid)
    assert.ok(held && held.port > 0 && held.token.length > 0, 'the owner publishes its lease next to the data')
    await release()
    assert.equal(await readJson(managerLockRecordPath(lock)), null, 'release removes the record it owns')
    const second = await acquireManagerLock(lock)
    await second()
    assert.equal(await readJson(lock), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a dead owner is taken over even when its port is now held by something else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-dead-lock-'))
  const lock = join(root, 'manager.lock')
  // An unrelated listener on the recorded port never answers with the token.
  const stranger = createServer(socket => socket.end('hello\n'))
  await new Promise<void>(resolve => stranger.listen(0, '127.0.0.1', resolve))
  try {
    const port = (stranger.address() as AddressInfo).port
    await writeJson(managerLockRecordPath(lock), { version: 1, port, pid: 999_999, token: 'stale-token', startedAt: '2026-01-01T00:00:00.000Z' })
    const release = await acquireManagerLock(lock)
    const current = await readJson<{ token: string }>(managerLockRecordPath(lock))
    assert.notEqual(current?.token, 'stale-token')
    await release()
    await writeJson(managerLockRecordPath(lock), { not: 'a record' })
    const again = await acquireManagerLock(lock)
    await again()
  } finally {
    stranger.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('an owner whose record was replaced reports the loss instead of managing on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-lost-lock-'))
  const lock = join(root, 'manager.lock')
  try {
    let lost = 0
    const release = await acquireManagerLock(lock, () => { lost++ }, { watchIntervalMs: 20 })
    await writeJson(managerLockRecordPath(lock), { version: 1, port: 1, pid: 1, token: 'intruder', startedAt: '2026-01-01T00:00:00.000Z' })
    for (let i = 0; i < 50 && lost === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(lost, 1)
    await release()
    assert.equal((await readJson<{ token: string }>(managerLockRecordPath(lock)))?.token, 'intruder', 'release never deletes a record it no longer owns')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('only one manager wins simultaneous acquisition attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-stale-lock-'))
  const lock = join(root, 'manager.lock')
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireManagerLock(lock)))
    const winners = attempts.filter(result => result.status === 'fulfilled')
    try { assert.equal(winners.length, 1) } finally {
      await Promise.all(winners.map(result => result.value()))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an abruptly terminated process releases manager ownership without deleting a stale lock', { timeout: 8000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-lock-process-'))
  const lock = join(root, 'manager.lock')
  const moduleUrl = new URL('../../src/host/storage/files.ts', import.meta.url).href
  const script = `import { acquireManagerLock } from ${JSON.stringify(moduleUrl)}; await acquireManagerLock(process.argv[1]); process.send('ready'); setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, lock], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ended = once(child, 'exit')
  try {
    await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('lock owner exited before ready') })])
    await assert.rejects(acquireManagerLock(lock), /另一个插件实例/)
    child.kill('SIGKILL')
    await ended
    const release = await acquireManagerLock(lock)
    await release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
    await rm(root, { recursive: true, force: true })
  }
})

test('Desktop discovery checks on every call and never rewrites the shared record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-home-中文 '))
  try {
    assert.equal((await detectDesktop(home)).status, 'absent')
    const path = machineStatePath(home)
    await writeJson(path, { version: 2, connectorIds: [], legacyMachineMigrated: true, desktop: { platform: process.platform, executablePath: process.execPath } })
    const before = await stat(path)
    assert.equal((await detectDesktop(home, process.platform, async () => true)).status, 'installed')
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
    await writeJson(path, { version: 2, connectorIds: [], legacyMachineMigrated: true, desktop: { platform: process.platform, executablePath: join(home, 'missing') } })
    assert.equal((await detectDesktop(home)).status, 'absent')
    await writeFile(path, '{broken')
    assert.equal((await detectDesktop(home)).status, 'error')
    assert.equal(await readFile(path, 'utf8'), '{broken')
  } finally { await rm(home, { recursive: true, force: true }) }
})
