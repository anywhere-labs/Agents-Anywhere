import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createDirectSession } from '../../../src/runtime/profiles/dsh/direct/create.js'
import { canonicalPath, DshSessionIds, dshHomeOf, MemoryAliasStore } from '../../../src/runtime/profiles/dsh/session-ids.js'
import { dshPluginSessionId } from '../../../src/domain/identity/dsh.js'
import { startFake } from '../../fixtures/fake-dsh-acp.js'

interface Vector { input: { connectorId: string, runtimeId: string, dshHome: string, platform: 'darwin' | 'linux' | 'win32', externalSessionId: string },
  output: { namespace: string, sessionId: string } }
const vectors = (JSON.parse(readFileSync(new URL('../../../../contracts/identity-vectors/1.0/vectors.json', import.meta.url), 'utf8')) as
  { categories: Record<string, { vectors: Vector[] }> }).categories['session.dshEndToEnd']!.vectors

describe('DSH session identity (DSH-2)', () => {
  test('source key and namespace match v2 for every POSIX end-to-end vector', async () => {
    const posix = vectors.filter(vector => vector.input.platform !== 'win32' && vector.input.dshHome.startsWith('/nonexistent'))
    expect(posix.length).toBeGreaterThan(5)
    for (const { input, output } of posix) {
      const ids = await DshSessionIds.forInstance({ connectorId: input.connectorId, runtimeId: input.runtimeId },
        { dshHome: input.dshHome }, new MemoryAliasStore(), {}, input.platform)
      expect(ids.namespace, JSON.stringify(input)).toBe(output.namespace)
      expect(await ids.platformId(input.externalSessionId), JSON.stringify(input)).toBe(output.sessionId)
    }
  })

  test('DSH_HOME falls back to the environment, then ~/.dsh', () => {
    expect(dshHomeOf({ dshHome: '/a/.dsh' }, { DSH_HOME: '/b' })).toBe('/a/.dsh')
    expect(dshHomeOf({}, { DSH_HOME: '/b' })).toBe('/b')
    expect(dshHomeOf({}, {})).toMatch(/\.dsh$/)
    expect(() => dshHomeOf({ dshHome: 'relative' })).toThrow(/absolute/)
  })

  test('canonical paths resolve existing symlinks and keep missing tails', async () => {
    const real = await canonicalPath('/tmp')
    expect(await canonicalPath('/tmp/aa-missing/x')).toBe(`${real}/aa-missing/x`)
  })

  test('aliases win over the formula, and AA-created plugin IDs invert', async () => {
    const store = new MemoryAliasStore()
    const ids = new DshSessionIds('conn_1', store)
    expect(await ids.platformId('0195-uuid')).toBe(dshPluginSessionId('conn_1', '0195-uuid'))
    await ids.remember({ platformSessionId: 'sess_platform_1', dshSessionId: '0195-uuid', route: 'direct', cwd: '/w', createdAt: 1 })
    expect(await ids.platformId('0195-uuid')).toBe('sess_platform_1')
    expect(await ids.dshId('sess_platform_1')).toBe('0195-uuid')
    const native = ids.pluginNativeId('sess_platform_2')
    expect(native).toMatch(/^aa_[0-9a-f]{16}_sess_platform_2$/)
    expect(await ids.platformId(native)).toBe('sess_platform_2')
    expect(await ids.dshId('sess_platform_2')).toBe(native)
    await expect(store.put({ platformSessionId: 'other', dshSessionId: '0195-uuid', route: 'direct', cwd: '/w', createdAt: 2 })).rejects.toThrow(/already aliased/)
  })
})

describe('direct-route creation never makes two sessions (DSH-2)', () => {
  test('a normal creation records the alias and clears the intent', async () => {
    const { route } = await startFake()
    const store = new MemoryAliasStore()
    const ids = new DshSessionIds('conn_1', store)
    const { session, adopted } = await createDirectSession(route, ids, { platformSessionId: 'sess_a', cwd: '/w' })
    expect(adopted).toBe(false)
    expect(await ids.dshId('sess_a')).toBe(session.externalSessionId)
    expect(store.intents.size).toBe(0)
    // Retrying the same AA session resumes the aliased DSH session.
    await session.close()
    const again = await createDirectSession(route, ids, { platformSessionId: 'sess_a', cwd: '/w' })
    expect(again.adopted).toBe(true)
    expect(again.session.externalSessionId).toBe(session.externalSessionId)
  })

  test('a lost session/new answer is reconciled by adopting the one new session in that cwd', async () => {
    const { fake, route } = await startFake()
    const store = new MemoryAliasStore()
    const ids = new DshSessionIds('conn_1', store)
    fake.dropNextNewSession = true
    await expect(createDirectSession(route, ids, { platformSessionId: 'sess_b', cwd: '/w' })).rejects.toThrow()
    expect(store.intents.has('sess_b')).toBe(true)
    const lost = fake.persisted[0]!.sessionId
    const retry = await createDirectSession(route, ids, { platformSessionId: 'sess_b', cwd: '/w' })
    expect(retry.adopted).toBe(true)
    expect(retry.session.externalSessionId).toBe(lost)
    expect(fake.persisted.filter(item => item.cwd === '/w').length).toBe(2) // cold-1 plus the adopted one, no third
    expect(store.intents.size).toBe(0)
  })

  test('an ambiguous cwd is not guessed: the retry creates a fresh session', async () => {
    const { fake, route } = await startFake()
    const store = new MemoryAliasStore()
    const ids = new DshSessionIds('conn_1', store)
    fake.dropNextNewSession = true
    await expect(createDirectSession(route, ids, { platformSessionId: 'sess_c', cwd: '/w' })).rejects.toThrow()
    // Someone else created a session in the same cwd meanwhile.
    fake.persisted.unshift({ sessionId: 'someone-else', cwd: '/w' })
    const retry = await createDirectSession(route, ids, { platformSessionId: 'sess_c', cwd: '/w' })
    expect(retry.adopted).toBe(false)
    expect(['someone-else', fake.persisted[2]!.sessionId]).not.toContain(retry.session.externalSessionId)
  })
})
