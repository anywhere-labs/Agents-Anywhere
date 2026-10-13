import { machineStatePath } from '../../src/host/desktop/machine-state.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireManagerLock, managerLockPort, readJson, writeJson } from '../../src/host/storage/files.js'
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

test('manager lock ports stay clear of the operating system ephemeral range', () => {
  // Windows hands 49152-65535 to outbound sockets and lets Hyper-V/WSL reserve
  // blocks inside it; Linux starts its default ephemeral range at 32768.
  for (const directory of ['C:\\Users\\test\\.agents-anywhere\\dsh-bridge-next', '/home/test/.agents-anywhere/dsh-bridge-next', 'C:\\数据 目录\\bridge']) {
    const port = managerLockPort(directory)
    assert.ok(port >= 16384 && port <= 32767, `${directory} derived ${port}`)
    assert.equal(port, managerLockPort(directory))
  }
  assert.equal(managerLockPort('C:\\Users\\Test\\Root', 'win32'), managerLockPort('c:\\users\\test\\root', 'win32'))
  assert.notEqual(managerLockPort('C:\\Users\\Test\\Root', 'win32'), managerLockPort('C:\\Users\\Test\\Other', 'win32'))
})

test('a port held by another program reports the lock port instead of a permission failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-lock-port-'))
  const port = managerLockPort(await realpath(root))
  // Windows refuses this bind with WSAEACCES rather than WSAEADDRINUSE whenever the
  // holder uses SO_EXCLUSIVEADDRUSE, which is how both the lock and the reporting
  // issues (#144, #164) surfaced.
  const squatter = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen({ host: '127.0.0.1', port, exclusive: true }, () => { squatter.off('error', reject); resolve() })
    })
    await assert.rejects(acquireManagerLock(join(root, 'manager.lock')), (error: unknown) => {
      assert.match((error as Error).message, /另一个插件实例/)
      assert.equal((error as { code?: string }).code, 'LOCK_PORT_UNAVAILABLE')
      assert.equal((error as { port?: number }).port, port)
      return true
    })
  } finally {
    await new Promise<void>(resolve => squatter.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
