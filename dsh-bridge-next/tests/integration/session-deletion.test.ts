import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { SyncFeed, type SyncOperation, type SyncTransport } from '../../src/host/dsh-runtime/sync.js'
import type { NativeRuntime } from '../../src/host/dsh-runtime/native.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 600; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

type Notice = { method: string, params: Record<string, unknown> }
function notifications(operations: SyncOperation[]): Notice[] {
  return operations.flatMap(op => op.kind === 'notifications' ? op.notifications as Notice[] : [])
}

function follow(native: NativeRuntime, checkpoints?: Map<string, unknown>) {
  const batches: { operations: SyncOperation[] }[] = [], errors: unknown[] = [], captures: string[] = []
  const transport: SyncTransport = {
    async ingestBatch(batch) { batches.push(batch as unknown as { operations: SyncOperation[] }) },
    async loadCheckpoint(id) { return checkpoints?.get(id) as Record<string, unknown> ?? null },
    async saveCheckpoint(id, checkpoint) { checkpoints?.set(id, checkpoint) },
    async deleteCheckpoint(id) { checkpoints?.delete(id) },
    async ingestSnapshot(request, pages) { captures.push(request.sessionId); for await (const _page of pages) { /* consumed */ } return { accepted: true } },
  }
  const feed = new SyncFeed(native, 'test', randomUUID(), transport, error => errors.push(error), checkpoints !== undefined)
  feed.start()
  return { feed, errors, captures, notes: () => notifications(batches.flatMap(b => b.operations)) }
}

const deletions = (notes: Notice[]) => notes.filter(n => n.method === 'session.source.updated' && n.params.availability === 'deleted')
const inventoried = (notes: Notice[]) => notes.some(n => n.method === 'session.inventory.complete')

/** A DSH home whose feeds and services are torn down however the test ends. */
async function runtime(t: { after: (fn: () => unknown) => void }, prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const fixture = await nativeRuntime(home)
  const feeds: ReturnType<typeof follow>[] = []
  t.after(async () => { for (const stream of feeds) stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const native = fixture.ctx.agentsAnywhereRuntime.native
  return { home, fixture, native, follow: (checkpoints?: Map<string, unknown>) => { const stream = follow(native, checkpoints); feeds.push(stream); return stream } }
}

test('a session DSH deleted is reported once, by the first inventory that lacks it', { timeout: 60_000 }, async t => {
  const { fixture, native, home, follow } = await runtime(t, 'dsh-deleted-')
  const id = SessionId('persisted-only')
  const checkpoints = new Map<string, unknown>()
  const first = follow(checkpoints)
  await until(() => inventoried(first.notes()), 'the first inventory completes')
  assert.ok(checkpoints.has(id), 'the session was published with a durable checkpoint')
  const stored = JSON.parse(await readFile(bridgePath(home, 'published-sessions.json'), 'utf8')) as { version: number, namespaces: Record<string, string[]> }
  assert.equal(stored.version, 1)
  assert.ok(stored.namespaces.test.includes(id), 'what was published is kept across restarts')
  assert.equal(deletions(first.notes()).length, 0)
  first.feed.close()
  // A listing that skipped persistence (its backend not ready, say) is not a deletion:
  // the backend itself still holds the log.
  const query = fixture.ctx.sessionQuery
  const listSessions = query.listSessions.bind(query)
  query.listSessions = async (signal?: AbortSignal) => (await listSessions(signal)).filter(entry => fixture.ctx.sessions.get(entry.header.id) !== undefined)
  const partial = follow(checkpoints)
  try {
    await until(() => inventoried(partial.notes()), 'the inventory over a live-only listing completes')
    assert.equal(deletions(partial.notes()).length, 0, 'nothing is reported deleted')
    assert.ok((await native.published.ids('test')).includes(id), 'and nothing is forgotten')
  } finally { partial.feed.close(); query.listSessions = listSessions }
  // DSH deletes the session's log while nothing is connected.
  const persistence = fixture.ctx.sessionPersistence as import('@deepseek-ai/dsh-session-persistence-jsonl').default
  const path = await persistence.resolveCurrentLog(id)
  assert.ok(path, 'the session has a persisted log')
  await rm(path)
  const second = follow(checkpoints)
  await until(() => inventoried(second.notes()), 'the second inventory completes')
  const deleted = deletions(second.notes())
  assert.equal(deleted.length, 1, 'one observation for the deleted session, none for sessions never published')
  assert.equal(deleted[0].params.sessionId, sessionId('test', id))
  assert.equal(deleted[0].params.externalSessionId, id)
  assert.equal(deleted[0].params.reason, 'deleted_in_dsh')
  assert.equal(deleted[0].params.observationOrigin, 'inventory')
  assert.equal(typeof deleted[0].params.observedAt, 'string')
  const complete = second.notes().find(n => n.method === 'session.inventory.complete')!
  assert.ok(!(complete.params.sessions as { externalSessionId: string }[]).some(s => s.externalSessionId === id), 'the inventory leaves it out')
  assert.ok(!checkpoints.has(id), 'its checkpoint goes with it')
  assert.ok(!(await native.published.ids('test')).includes(id), 'forgotten here once reported')
  assert.deepEqual(second.errors, [])
  second.feed.close()
  const third = follow(checkpoints)
  await until(() => inventoried(third.notes()), 'the third inventory completes')
  assert.equal(deletions(third.notes()).length, 0, 'a reconnect does not report it again')
  assert.deepEqual(third.errors, [])
})

test('a published session that leaves memory is reported deleted only when a fresh inventory lacks it', { timeout: 60_000 }, async t => {
  const { home, fixture, native, follow } = await runtime(t, 'dsh-disposed-')
  const stream = follow()
  await until(() => inventoried(stream.notes()), 'the inventory completes')
  // A first capture carries the session's meta; only a resumed one repeats it as a notification.
  const published = (externalId: string) => stream.captures.includes(sessionId('test', externalId))
  // DSH keeps a session it persisted; one it never persisted is gone once it leaves memory.
  const keep = SessionId('disposed-persisted'), gone = SessionId('disposed-unpersisted')
  const keepSession = fixture.ctx.sessions.prepare(keep, { meta: { cwd: home } })
  const keepAttached = fixture.ctx.sessions.enter(keepSession)
  fixture.ctx.sessions.announce(keepSession)
  keepSession.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '保留' }] }), { surfaceOp: 'append' })
  await fixture.ctx.sessions.flush(keepSession)
  await until(() => published(keep), 'the persisted session is published')
  const goneSession = fixture.ctx.sessions.prepare(gone, { meta: { cwd: home } })
  const goneAttached = fixture.ctx.sessions.enter(goneSession)
  fixture.ctx.sessions.announce(goneSession)
  goneSession.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '丢弃' }] }), { surfaceOp: 'append' })
  await until(() => published(gone), 'the unpersisted session is published')
  keepAttached()
  await delay(400)
  assert.equal(deletions(stream.notes()).length, 0, 'a session DSH still holds is not reported deleted')
  goneAttached()
  await until(() => deletions(stream.notes()).length === 1, 'the session that is gone is reported')
  assert.equal(deletions(stream.notes())[0].params.externalSessionId, gone)
  assert.ok((await native.published.ids('test')).includes(keep))
  assert.ok(!(await native.published.ids('test')).includes(gone))
  assert.deepEqual(stream.errors, [])
})
