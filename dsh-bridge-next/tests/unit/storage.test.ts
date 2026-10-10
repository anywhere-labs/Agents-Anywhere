import { machineStatePath } from '../../src/host/desktop/machine-state.js'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCompatibleManagerLock, acquireManagerLock, managerLockPort, readJson, writeJson } from '../../src/host/storage/files.js'
import { holdOlderPluginLease } from '../helpers/older-plugin-lease.js'
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
    await release()
    const second = await acquireManagerLock(lock)
    await second()
    assert.equal(await readJson(lock), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

/** Fails listen() on `refused` ports with EACCES, as an OS refusal would; returns the ports bound. */
function refusePorts(t: TestContext, refused: Set<number>): number[] {
  const bound: number[] = []
  const listen = Server.prototype.listen as (this: Server, ...args: unknown[]) => Server
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    const port = (args[0] as { port?: number } | undefined)?.port
    if (port !== undefined && refused.has(port)) {
      const error = Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), { code: 'EACCES' })
      process.nextTick(() => this.emit('error', error))
      return this
    }
    if (port !== undefined) this.once('listening', () => bound.push(port))
    return listen.apply(this, args)
  })
  return bound
}

async function lockPath(t: TestContext): Promise<{ lock: string, identity: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aa-manager-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = await realpath(root)
  return { lock: join(root, 'manager.lock'), identity: process.platform === 'win32' ? directory.toLowerCase() : directory }
}

test('the manager lease is a named pipe on Windows and one port below the dynamic range elsewhere', async t => {
  assert.equal(managerLockPort('/home/me/.agents-anywhere/dsh-bridge-next'), 32601)
  assert.equal(managerLockPort('/home/me/.agents-anywhere/dsh-bridge-next', 49152), 65369, 'plugins up to 2.0.3')
  const { lock, identity } = await lockPath(t)
  const bound = refusePorts(t, new Set())
  const release = await acquireManagerLock(lock)
  await release()
  assert.deepEqual(bound, process.platform === 'win32' ? [] : [managerLockPort(identity)])
})

test('an OS refusal of the lease port is reported instead of skipped', async t => {
  if (process.platform === 'win32') { t.skip('the Windows lease is a named pipe'); return }
  const { lock, identity } = await lockPath(t)
  refusePorts(t, new Set([managerLockPort(identity)]))
  await assert.rejects(acquireManagerLock(lock), { code: 'EACCES' })
})

test('a path older plugins may use is leased both ways', async t => {
  const { lock } = await lockPath(t)
  const release = await acquireCompatibleManagerLock(lock)
  try {
    await assert.rejects(acquireManagerLock(lock), /另一个插件实例/)
    await assert.rejects(acquireCompatibleManagerLock(lock), /另一个插件实例/)
    assert.equal(await holdOlderPluginLease(lock), undefined, 'an older plugin cannot lease it')
  } finally { await release() }
  const again = await acquireCompatibleManagerLock(lock)
  await again()
})

test('a path an older plugin holds is refused without keeping the new lease', async t => {
  const { lock } = await lockPath(t)
  const releaseOld = await holdOlderPluginLease(lock)
  if (!releaseOld) { t.skip('this machine cannot bind the older plugin\'s lease port'); return }
  try {
    await assert.rejects(acquireCompatibleManagerLock(lock), /另一个插件实例/)
    const own = await acquireManagerLock(lock)
    await own()
  } finally { await releaseOld() }
})

test('when the OS refuses the older plugins\' port, the compatible lease keeps only the new one', async t => {
  const { lock, identity } = await lockPath(t)
  refusePorts(t, new Set([managerLockPort(identity, 49152)]))
  const release = await acquireCompatibleManagerLock(lock)
  try { await assert.rejects(acquireManagerLock(lock), /另一个插件实例/) }
  finally { await release() }
  const own = await acquireManagerLock(lock)
  await own()
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
