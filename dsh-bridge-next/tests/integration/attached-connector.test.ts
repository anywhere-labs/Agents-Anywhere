import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AttachedConnector, CONNECTOR_ABSENT, publishedConnector } from '../../src/host/connector/attached.js'
import type { RuntimeDiagnostics } from '../../src/host/dsh-runtime/diagnostics.js'

const LOST = '本机 Connector 已停止。它由系统服务管理，重新启动后这里会自动连接。'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'aa-attached-'))
  const bridge = join(root, '.agents-anywhere', 'dsh-bridge')
  await mkdir(bridge, { recursive: true })
  const path = join(bridge, 'connector.json')
  const key = 'mk_' + 'k'.repeat(40)
  const publish = (instanceId: string, pid: number, secret = key) => writeFile(path, JSON.stringify({
    version: 2, protocol: 'meshcall', instanceId, pid,
    endpoint: { unixPath: join(root, 'router.sock') }, key: secret,
  }))
  const events: string[] = []
  const created: AttachedConnector[] = []
  const create = (options: object = {}) => {
    const connector = new AttachedConnector({ rendezvousPath: path, pollMs: 10, lostAfterMs: 100, ...options })
    connector.onState(state => { events.push(state.running ? 'up' : 'down') })
    created.push(connector)
    return connector
  }
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let count = 0; count < 500 && !(await check()); count++) await delay(10)
    assert.ok(await check(), 'expected state did not arrive')
  }
  // A failed assertion must not leave a follower behind.
  t.after(async () => { for (const connector of created) await connector.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, bridge, path, publish, events, create, until }
}

/** A pid that existed a moment ago and no longer does. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  assert.ok(child.pid)
  await new Promise(resolve => child.once('close', resolve))
  return child.pid
}

/** A pid that stays alive until the test ends. */
function livePid(t: TestContext): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  assert.ok(child.pid)
  t.after(() => child.kill())
  return child
}
const exited = (child: ChildProcess) => new Promise(resolve => child.once('close', resolve))
const linkOf = (connector: AttachedConnector) => (connector as unknown as { link: { instanceId: string; key: string } | null }).link

const binding = {} as never
const signal = () => new AbortController().signal

test('attaches to the published Connector and writes nothing', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  const before = await readFile(h.path, 'utf8')
  const connector = h.create()
  await connector.prepare()
  await connector.resetEnvironment()
  await connector.start(binding, 'https://api.example.test', signal())
  assert.equal(connector.running, true)
  assert.equal(connector.lastError, null)
  assert.equal(connector.logsPath, join(h.root, '.agents-anywhere', 'logs'))
  assert.deepEqual(h.events, ['up'])
  await connector.assertHealthy()
  // The rendezvous and its directory belong to the Connector, not to the plugin.
  assert.equal(await readFile(h.path, 'utf8'), before)
  assert.deepEqual((await readdir(h.bridge)).sort(), ['connector.json'])
  await connector.stop()
})

test('waits for a Connector that is still starting; a stale file is not a Connector', async t => {
  const h = await fixture(t)
  await h.publish('gone', await deadPid())
  assert.equal(await publishedConnector(h.path), null, 'a dead pid behind a file is not a Connector')
  const impatient = h.create({ attachTimeoutMs: 60 })
  await assert.rejects(impatient.start(binding, '', signal()), { message: CONNECTOR_ABSENT })
  assert.equal(impatient.running, false)
  const patient = h.create()
  const starting = patient.start(binding, '', signal())
  await delay(40)
  assert.equal(patient.running, false)
  await h.publish('connector-b', process.pid)
  await starting
  assert.equal(patient.running, true)
  await patient.stop()
})

test('an aborted start stops waiting', async t => {
  const h = await fixture(t)
  const connector = h.create()
  const controller = new AbortController()
  const starting = connector.start(binding, '', controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(starting, { name: 'AbortError' })
  assert.equal(connector.running, false)
})

test('follows a replaced Connector and reports one that stays away', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  const connector = h.create()
  await connector.start(binding, '', signal())
  // The service restarts its Connector: a new instance, and the plugin follows it.
  await h.publish('connector-b', process.pid)
  await h.until(async () => (await publishedConnector(h.path))?.instanceId === 'connector-b' && (connector as unknown as { link: { instanceId: string } }).link.instanceId === 'connector-b')
  assert.equal(connector.running, true)
  assert.deepEqual(h.events, ['up'], 'a replacement is not an outage')
  // The Connector exits and nothing republishes: that is an outage, once the grace period is over.
  await h.publish('gone', await deadPid())
  await h.until(() => !connector.running)
  assert.equal(connector.lastError, LOST)
  await assert.rejects(connector.assertHealthy(), { message: LOST })
  assert.deepEqual(h.events, ['up', 'down'])
  // It comes back: followed again, failure cleared.
  await h.publish('connector-c', process.pid)
  await h.until(() => connector.running)
  assert.equal(connector.lastError, null)
  await connector.assertHealthy()
  assert.deepEqual(h.events, ['up', 'down', 'up'])
  await connector.stop()
})

test('stop() stops following and leaves the Connector alone', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  const connector = h.create()
  await connector.start(binding, '', signal())
  await connector.stop()
  assert.equal(connector.running, false)
  assert.equal(connector.lastError, null)
  await assert.rejects(connector.assertHealthy(), { message: CONNECTOR_ABSENT })
  assert.equal((await publishedConnector(h.path))?.instanceId, 'connector-a', 'still published, still running')
  // Nothing that happens afterwards is followed, not even a new instance three polls later.
  await h.publish('connector-b', process.pid)
  await delay(150)
  assert.equal(connector.running, false)
  assert.equal(connector.lastError, null)
  assert.deepEqual(h.events, ['up', 'down'])
  await connector.start(binding, '', signal())
  assert.equal(connector.running, true)
  await connector.stop()
})

test('publishedConnector() ignores a missing or malformed rendezvous', async t => {
  const h = await fixture(t)
  assert.equal(await publishedConnector(h.path), null)
  await h.publish('connector-a', process.pid)
  assert.equal((await publishedConnector(h.path))?.pid, process.pid)
  await writeFile(h.path, JSON.stringify({ version: 2, protocol: 'meshcall' }))
  assert.equal(await publishedConnector(h.path), null)
})

test('a stale file whose pid now belongs to another process is not a Connector', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  // The file was written at T. A process that started after T did not write it.
  const started = (offset: number) => async () => (await stat(h.path)).mtimeMs + offset
  const late = h.create({ attachTimeoutMs: 60, processStartedAt: started(5_000) })
  await assert.rejects(late.start(binding, '', signal()), { message: CONNECTOR_ABSENT })
  assert.equal(late.running, false)
  assert.deepEqual(h.events, [])
  assert.equal(await publishedConnector(h.path, { processStartedAt: started(5_000) }), null)
  await h.create({ processStartedAt: started(-5_000) }).start(binding, '', signal())
  assert.deepEqual(h.events, ['up'], 'the process that wrote the file started before it was written')
  await h.create({ processStartedAt: async () => null }).start(binding, '', signal())
  assert.deepEqual(h.events, ['up', 'up'], 'a start time that cannot be read is not a verdict')
})

test('a pid that was seen dead is asked again who it is once it answers, not trusted from memory', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  // The file was written at T. The process behind the pid wrote it; later, after the plugin has seen that pid die,
  // the number belongs to a process that started after T.
  let asked = 0
  let successor = false
  const connector = h.create({ processStartedAt: async () => {
    asked++
    return (await stat(h.path)).mtimeMs + (successor ? 5_000 : -5_000)
  } })
  // The pid is this test's own, which cannot be made to die: its death is simulated where the plugin looks for it.
  const realKill = process.kill
  let dead = false
  process.kill = ((pid: number, sig?: number) => {
    if (dead && pid === process.pid) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    return realKill(pid, sig as number)
  }) as typeof process.kill
  t.after(() => { process.kill = realKill })
  await connector.start(binding, '', signal())
  assert.equal(asked, 1, 'one question for one adoption')
  assert.equal(connector.running, true)
  dead = true
  await h.until(async () => connector.lastError === LOST)
  dead = false
  successor = true
  await delay(150)
  assert.equal(connector.running, false, 'a process that only inherited the pid is not the Connector')
  assert.ok(asked >= 2, 'the pid was asked again after it had been seen dead')
  await assert.rejects(connector.assertHealthy(), { message: LOST })
  await connector.stop()
})

test('a stop() that lands after the waiting loop has seen the Connector adopts nothing', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  // reconcile() logs the adoption after its own abort check and before start() acts on the answer. A stop()
  // queued right there runs before start() can adopt, every time, without depending on timer luck.
  let connector!: AttachedConnector
  const diagnostics = {
    log(_level: string, event: string) { if (event === 'connector.attached') queueMicrotask(() => { void connector.stop() }) },
  } as unknown as RuntimeDiagnostics
  connector = h.create({ diagnostics })
  await assert.rejects(connector.start(binding, '', signal()), { name: 'AbortError' })
  assert.equal(linkOf(connector), null)
  await delay(60)
  assert.equal(connector.running, false, 'nothing was adopted after stop()')
  assert.deepEqual(h.events, [])
  await assert.rejects(connector.assertHealthy(), { message: CONNECTOR_ABSENT })
})

test('a start queued behind another is void when stop() comes between', async t => {
  const h = await fixture(t)
  // A short attach timeout: if the queued start were not voided, it would fail that way, at once, not by the suite's timeout.
  const connector = h.create({ attachTimeoutMs: 100 })
  const first = connector.start(binding, '', signal())
  const second = connector.start(binding, '', signal())
  await connector.stop()
  await assert.rejects(first, { name: 'AbortError' })
  await assert.rejects(second, { name: 'AbortError' }, 'a start that was only queued is void after stop()')
  await h.publish('connector-b', process.pid)
  await delay(60)
  assert.equal(connector.running, false)
  assert.equal(linkOf(connector), null)
  assert.deepEqual(h.events, [])
})
test('pid 0, a negative pid and a fractional pid are not alive; a process of another user is', async t => {
  const h = await fixture(t)
  for (const pid of [0, -1, 1.5]) {
    await h.publish('not-a-process', pid)
    assert.equal(await publishedConnector(h.path), null, `pid ${pid}`)
  }
  try { process.kill(1, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') { t.skip('pid 1 is not another user\'s process here'); return }
  }
  await h.publish('launchd', 1)
  assert.equal((await publishedConnector(h.path))?.pid, 1)
})

test('assertHealthy() gives a replaced Connector its grace period, then calls it lost', async t => {
  const h = await fixture(t)
  const child = livePid(t)
  await h.publish('connector-a', child.pid!)
  const connector = h.create({ lostAfterMs: 400 })
  await connector.start(binding, '', signal())
  child.kill('SIGKILL')
  await exited(child)
  // Just gone: slow is not unhealthy, the caller polls again.
  await connector.assertHealthy()
  assert.equal(connector.running, true)
  await h.until(() => !connector.running)
  await assert.rejects(connector.assertHealthy(), { message: LOST })
  assert.deepEqual(h.events, ['up', 'down'])
})

test('a Connector replaced inside the grace window is never an outage', async t => {
  const h = await fixture(t)
  const child = livePid(t)
  await h.publish('connector-a', child.pid!)
  const connector = h.create({ lostAfterMs: 150 })
  await connector.start(binding, '', signal())
  child.kill('SIGKILL')
  await exited(child)
  await h.publish('connector-b', process.pid)
  await connector.assertHealthy()
  await delay(300)
  assert.equal(connector.running, true)
  assert.equal(connector.lastError, null)
  assert.deepEqual(h.events, ['up'])
})

test('a Connector that stopped cleanly is lost once the grace period is over, and followed when it returns', async t => {
  const h = await fixture(t)
  const child = livePid(t)
  await h.publish('connector-a', child.pid!)
  const connector = h.create({ lostAfterMs: 100 })
  await connector.start(binding, '', signal())
  child.kill('SIGKILL')
  await exited(child)
  await rm(h.path)
  assert.equal(connector.running, true, 'the grace period is not an outage')
  await h.until(() => !connector.running)
  assert.equal(connector.lastError, LOST)
  await h.publish('connector-b', process.pid)
  await h.until(() => connector.running)
  assert.equal(connector.lastError, null)
  await connector.assertHealthy()
  assert.deepEqual(h.events, ['up', 'down', 'up'])
})

test('two concurrent starts both end up following the one Connector', async t => {
  const h = await fixture(t)
  const connector = h.create()
  const both = Promise.all([connector.start(binding, '', signal()), connector.start(binding, '', signal())])
  await delay(40)
  assert.equal(connector.running, false)
  await h.publish('connector-a', process.pid)
  await both
  assert.equal(connector.running, true)
  await connector.assertHealthy()
  await connector.stop()
})

test('stop() ends a start that is still waiting', async t => {
  const h = await fixture(t)
  const connector = h.create()
  const starting = connector.start(binding, '', signal())
  await delay(20)
  await connector.stop()
  await assert.rejects(starting, { name: 'AbortError' })
  await h.publish('connector-a', process.pid)
  await connector.start(binding, '', signal())
  assert.equal(connector.running, true)
  await connector.stop()
})

test('the follow loop survives a failed poll', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  const logs: string[] = []
  let broke = false
  const connector = h.create({
    processStartedAt: async () => { if (broke) throw new Error('ps broke'); return null },
    diagnostics: { log: (level: string, event: string) => { logs.push(level + ' ' + event) } } as unknown as RuntimeDiagnostics,
  })
  await connector.start(binding, '', signal())
  broke = true
  // A new publication has to be judged, and judging it fails: following itself must not end.
  await h.publish('connector-b', process.pid)
  await delay(100)
  assert.ok(logs.includes('warn connector.follow_failed'), logs.join(', '))
  assert.equal(connector.running, true, 'still following the Connector it had')
  assert.equal(linkOf(connector)?.instanceId, 'connector-a')
  broke = false
  await h.until(() => linkOf(connector)?.instanceId === 'connector-b')
  assert.deepEqual(h.events, ['up'])
  await connector.stop()
})

test('a poll that was still reading when stop() came adopts nothing afterwards', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  let release!: () => void
  let asked = 0
  // Judging a new publication waits here, so stop() lands after the read and before the verdict.
  const gate = new Promise<void>(resolve => { release = resolve })
  const connector = h.create({ processStartedAt: async () => { if (++asked === 1) return null; await gate; return null } })
  await connector.start(binding, '', signal())
  await h.publish('connector-b', process.pid)
  await h.until(() => asked > 1)
  await connector.stop()
  release()
  await delay(60)
  assert.equal(connector.running, false, 'what was read before stop() is not a Connector to follow')
  assert.equal(linkOf(connector), null)
  assert.deepEqual(h.events, ['up', 'down'])
})
test('the same instance publishing a new key is followed', async t => {
  const h = await fixture(t)
  await h.publish('connector-a', process.pid)
  const connector = h.create()
  await connector.start(binding, '', signal())
  const rotated = 'mk_' + 'n'.repeat(40)
  await h.publish('connector-a', process.pid, rotated)
  await h.until(() => linkOf(connector)?.key === rotated)
  assert.deepEqual(h.events, ['up'], 'a new key is not an outage')
  await connector.stop()
})
