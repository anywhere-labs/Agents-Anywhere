import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncFeed } from '../../src/host/dsh-runtime/sync.js'
import type { NativeRuntime } from '../../src/host/dsh-runtime/native.js'

function fixture(progress = true) {
  const native = { watch: () => () => {}, diagnostics: { log() {} } } as unknown as NativeRuntime
  const feed = new SyncFeed(native, 'test', () => {}, () => {}, 60_000, true, progress)
  const transmit = Reflect.get(feed, 'transmit') as (operations: unknown[]) => Promise<void>
  return { feed, send: () => transmit.call(feed, [{ kind: 'snapshot.commit' }]) }
}

test('upload progress extends inactivity deadline without acknowledging the batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { feed, send } = fixture()
  let completed = false
  const pending = send().then(() => { completed = true })
  try {
    for (let n = 1; n <= 4; n++) {
      t.mock.timers.tick(40_000)
      feed.progress(1, n * 65_536)
      await Promise.resolve()
      assert.equal(completed, false)
    }
    feed.ack(1)
    await pending
    assert.equal(completed, true)
  } finally { feed.close() }
})

test('a stalled upload still times out after its last advancing progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { feed, send } = fixture()
  const pending = send()
  const failed = assert.rejects(pending, /acknowledgement timed out/)
  t.mock.timers.tick(40_000)
  feed.progress(1, 65_536)
  t.mock.timers.tick(40_000)
  feed.progress(1, 65_536) // Repeated byte counts cannot keep a stuck upload alive.
  t.mock.timers.tick(20_000)
  await failed
  feed.close()
})

test('progress must be negotiated and belong to the pending batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { feed, send } = fixture()
  const pending = send()
  try {
    for (const [seq, bytes] of [[0, 1], [2, 1], [1, -1], [1, 1.5], [1, Number.MAX_SAFE_INTEGER + 1]]) {
      assert.throws(() => feed.progress(seq!, bytes!), /Invalid upload progress/)
    }
    feed.ack(1)
    await pending
    assert.throws(() => feed.progress(1, 2), /Invalid upload progress/)
  } finally { feed.close() }
  const legacy = fixture(false)
  const oldPending = legacy.send()
  assert.throws(() => legacy.feed.progress(1, 1), /Invalid upload progress/)
  legacy.feed.ack(1)
  await oldPending
  legacy.feed.close()
})
