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
    // A record nothing can parse forgets what was published; it never fails the Host.
    await writeFile(path, '{not json')
    assert.deepEqual(await new PublishedSessions(path).ids('b'), [])
    const memory = new PublishedSessions()
    await memory.add('a', 'live-only')
    assert.deepEqual(await memory.ids('a'), ['live-only'])
    assert.deepEqual(await new PublishedSessions().ids('a'), [])
  } finally { await rm(home, { recursive: true, force: true }) }
})
