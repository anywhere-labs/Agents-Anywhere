import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LogStore, redact } from '../../src/host/index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-logs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const record = (message: string, extra: Record<string, unknown> = {}) => ({ time: '2026-11-16T00:00:00Z', level: 'INFO', name: 'test', message, ...extra })

describe('redaction (v2 log_redaction.py vectors)', () => {
  it('matches v2 output', () => {
    const vectors: [string, string][] = [
      ['token mk_abc-123 here', 'token [REDACTED] here'],
      ['Authorization: Bearer abc.def==', 'Authorization: Bearer [REDACTED]'],
      ['{"connectorToken":"xyz"}', '{"connectorToken":"[REDACTED]"}'],
      ['password=hunter2, ok', 'password=[REDACTED], ok'],
      ['api_key: Connector abc', 'api_key: Connector [REDACTED]'],
      ['\\"key\\": \\"v\\"', '\\"key\\": \\"[REDACTED]\\"'],
      ['the key is fine', 'the key is fine'],
      ['Basic dXNlcjpwYXNz', 'Basic [REDACTED]'],
    ]
    for (const [input, expected] of vectors) expect(redact(input)).toBe(expected)
  })
})

describe('runtime log journal', () => {
  it('appends redacted records with increasing seq, deduplicates bridge retries and pages', async () => {
    const store = await LogStore.open(join(dir, 'logs'))
    expect(await store.append([record('a password=x'), record('b')], 'connector', false)).toBe(2)
    const bridge = [record('c', { producer: 'p', eventId: 'e1' }), record('d', { producer: 'p', eventId: 'e2' })]
    expect(await store.append(bridge, 'bridge')).toBe(2)
    expect(await store.append(bridge, 'bridge')).toBe(0)
    const page = await store.read()
    expect(page.items.map(item => [item.seq, item.source, item.message])).toEqual([[1, 'connector', 'a password=[REDACTED]'], [2, 'connector', 'b'], [3, 'bridge', 'c'], [4, 'bridge', 'd']])
    expect(await store.read({ source: 'bridge', limit: 1 })).toMatchObject({ items: [{ seq: 4 }], total: 2, hasMoreBefore: true, hasMoreAfter: false })
    expect(await store.read({ afterSeq: 1, limit: 2 })).toMatchObject({ items: [{ seq: 2 }, { seq: 3 }], hasMoreAfter: true })
    expect(await store.read({ beforeSeq: 3 })).toMatchObject({ items: [{ seq: 1 }, { seq: 2 }] })
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700)
    await store.close()
  })

  it('survives a restart, recovers a torn tail and a damaged state, and keeps counting after clear', async () => {
    const path = join(dir, 'logs')
    const first = await LogStore.open(path)
    await first.append([record('one'), record('two')], 'connector')
    await first.close()
    const segment = readdirSync(path).find(name => name.startsWith('runtime-'))!
    appendFileSync(join(path, segment), '[{"seq": 3, "torn')
    writeFileSync(join(path, 'state.json'), 'garbage')
    const second = await LogStore.open(path)
    expect((await second.read()).items.map(item => item.message)).toEqual(['one', 'two'])
    expect(readFileSync(join(path, segment), 'utf8').endsWith('\n')).toBe(true)
    await second.append([record('three')], 'connector')
    expect((await second.read()).lastSeq).toBe(3)
    expect(await second.clear()).toMatchObject({ items: [], total: 0 })
    await second.append([record('four')], 'connector')
    expect((await second.read()).items.map(item => item.seq)).toEqual([4])
    await second.close()
    const third = await LogStore.open(path)
    expect((await third.read()).items.map(item => item.seq)).toEqual([4])
    await third.close()
  })

  it('drops whole old segments past the row, byte and age limits', async () => {
    let now = Date.UTC(2026, 10, 16)
    const store = await LogStore.open(join(dir, 'logs'), { maxRows: 3, now: () => now })
    for (let i = 1; i <= 7; i++) await store.append([record(`m${i}`)], 'connector', false)
    const rows = (await store.read()).items.map(item => item.seq)
    expect(rows.length).toBeLessThanOrEqual(3)
    expect(rows.at(-1)).toBe(7)
    now += 8 * 86_400_000
    expect((await store.read()).items).toEqual([])
    await store.close()
  })

  it('tails history then follows, marking a retention gap', async () => {
    const store = await LogStore.open(null, { maxRows: 2 })
    expect(store.persistent).toBe(false)
    for (let i = 1; i <= 4; i++) await store.append([record(`m${i}`)], 'connector')
    const abort = new AbortController()
    const tail = store.tail(0, null, abort.signal)
    const first = await tail.next()
    expect(first.value).toMatchObject({ seq: 3, gapBefore: true })
    expect((await tail.next()).value).toMatchObject({ seq: 4 })
    const next = tail.next()
    await store.append([record('m5')], 'connector')
    expect((await next).value).toMatchObject({ seq: 5, message: 'm5' })
    abort.abort()
    expect((await tail.next()).done).toBe(true)
  })

  it('falls back to memory when the directory cannot be used', async () => {
    writeFileSync(join(dir, 'file'), 'x')
    const store = await LogStore.open(join(dir, 'file', 'logs'))
    expect(store.persistent).toBe(false)
    expect(await store.append([record('still works')], 'connector')).toBe(1)
  })
})
