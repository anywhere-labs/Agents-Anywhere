import { machineStatePath } from '../../src/host/desktop/machine-state.js'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startupFailure } from '../../src/host/dsh-runtime/startup-status.js'
import { acquireManagerLock, managerLockPorts, readJson, writeJson } from '../../src/host/storage/files.js'
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

/** Fails listen() on `reserved` the way Windows excluded port ranges do; returns the ports bound. */
function reservePorts(t: TestContext, reserved: Set<number>): number[] {
  const bound: number[] = []
  const listen = Server.prototype.listen as (this: Server, ...args: unknown[]) => Server
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    const port = (args[0] as { port?: number } | undefined)?.port
    if (port !== undefined && reserved.has(port)) {
      const error = Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), { code: 'EACCES' })
      process.nextTick(() => this.emit('error', error))
      return this
    }
    if (port !== undefined) this.once('listening', () => bound.push(port))
    return listen.apply(this, args)
  })
  return bound
}

async function lockPorts(t: TestContext): Promise<{ lock: string, ports: number[] }> {
  const root = await mkdtemp(join(tmpdir(), 'aa-reserved-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = await realpath(root)
  return { lock: join(root, 'manager.lock'), ports: managerLockPorts(process.platform === 'win32' ? directory.toLowerCase() : directory) }
}

test('manager lock ports spread evenly from the directory hash', () => {
  assert.deepEqual(managerLockPorts('/home/me/.agents-anywhere/dsh-bridge-next'), [
    65369, 50009, 51033, 52057, 53081, 54105, 55129, 56153,
    57177, 58201, 59225, 60249, 61273, 62297, 63321, 64345,
  ])
})

test('the manager lock moves past ports the OS reserves but never past a held one', async t => {
  const { lock, ports } = await lockPorts(t)
  const bound = reservePorts(t, new Set(ports.slice(0, 2)))
  const release = await acquireManagerLock(lock)
  // Usually ports[2]; later when this machine really reserves that one as well.
  assert.equal(bound.length, 1)
  assert.ok(ports.indexOf(bound[0]!) >= 2)
  await assert.rejects(acquireManagerLock(lock), /另一个插件实例/)
  await release()
  const second = await acquireManagerLock(lock)
  await second()
  assert.deepEqual(bound, [bound[0], bound[0]])
})

test('the manager lock explains when the OS reserves every port', async t => {
  const { lock, ports } = await lockPorts(t)
  reservePorts(t, new Set(ports))
  const failure = await acquireManagerLock(lock).then(() => assert.fail('Claimed a reserved port'), (error: unknown) => error)
  assert.match(String(failure), /系统保留/)
  assert.equal(startupFailure(failure).code, 'BRIDGE_PORTS_RESERVED')
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
