import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PublishedSessions } from '../../src/host/dsh-runtime/published-sessions.js'

test('published sessions persist per namespace and tolerate a damaged record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-published-'))
  const path = join(home, 'nested', 'published-sessions.json')
  try {
    const store = new PublishedSessions(path)
    assert.deepEqual(await store.ids('a'), [])
    await store.add('a', 'one'); await store.add('a', 'one'); await store.add('b', 'other')
    const reread = new PublishedSessions(path)
    assert.deepEqual(await reread.ids('a'), ['one'])
    assert.deepEqual(await reread.ids('b'), ['other'])
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1)
    await reread.remove('a', 'one'); await reread.remove('a', 'one')
    assert.deepEqual(await new PublishedSessions(path).ids('a'), [])
    assert.deepEqual(await new PublishedSessions(path).ids('b'), ['other'])
    // A record nothing can parse forgets what was published; it never fails the Host,
    // but says so, since the deletions it would have told are lost with it.
    await writeFile(path, '{not json')
    const unreadable: unknown[] = []
    assert.deepEqual(await new PublishedSessions(path, error => unreadable.push(error)).ids('b'), [])
    assert.equal(unreadable.length, 1)
    await writeFile(path, JSON.stringify({ version: 2, namespaces: { b: ['other'] } }))
    assert.deepEqual(await new PublishedSessions(path, error => unreadable.push(error)).ids('b'), [])
    assert.equal(unreadable.length, 2)
    await writeFile(path, JSON.stringify({ version: 1, namespaces: 'nope' }))
    assert.deepEqual(await new PublishedSessions(path, error => unreadable.push(error)).ids('b'), [])
    assert.equal(unreadable.length, 3)
    // A missing record is the normal first start, not a loss.
    await rm(path)
    assert.deepEqual(await new PublishedSessions(path, error => unreadable.push(error)).ids('b'), [])
    assert.equal(unreadable.length, 3)
    await writeFile(path, JSON.stringify({ version: 1, namespaces: { b: ['other'] } }))
    const quiet: unknown[] = []
    assert.deepEqual(await new PublishedSessions(path, error => quiet.push(error)).ids('b'), ['other'])
    assert.deepEqual(quiet, [])
    const memory = new PublishedSessions()
    await memory.add('a', 'live-only')
    assert.deepEqual(await memory.ids('a'), ['live-only'])
    assert.deepEqual(await new PublishedSessions().ids('a'), [])
  } finally { await rm(home, { recursive: true, force: true }) }
})
