import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WorkspaceRegistry, { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BridgeError } from '../../src/host/dsh-runtime/errors.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import { RuntimeRouter, type SessionReader } from '../../src/host/dsh-runtime/router.js'
import type { NativeRuntime } from '../../src/host/dsh-runtime/native.js'
import { commandRuntime } from '../fixtures/command-runtime.js'

/** The native surface `setSessionArchived` needs, without a real DSH Context. */
class FakeNative {
  calls: { id: string, archived: boolean }[] = []
  failure: Error | undefined
  source = {
    initialize: async () => {},
    retry: () => {},
    requireAvailable: async () => {},
    state: async (id: string) => ({ availability: id === 'archived' ? 'archived' as const : 'available' as const, reason: null, observedAt: 'now' }),
  }

  candidates() { return ['native-1'] }

  async setArchived(id: string, archived: boolean) {
    this.calls.push({ id, archived })
    if (this.failure) throw this.failure
    return { archived }
  }
}

function router(native: FakeNative | undefined) {
  const reader = { ...(native ? { native: native as unknown as NativeRuntime } : {}), query: {}, status: () => undefined }
  return new RuntimeRouter(reader as unknown as SessionReader, 'test')
}

const signal = new AbortController().signal
const params = (nativeId: string, archived: boolean) => ({
  sessionId: sessionId('test', nativeId), externalSessionId: nativeId, archived,
})

test('setSessionArchived forwards the native archive state to the runtime', async () => {
  const native = new FakeNative()
  const archive = await router(native).request('setSessionArchived', params('native-1', true), signal) as Record<string, unknown>
  assert.deepEqual(native.calls, [{ id: 'native-1', archived: true }])
  assert.equal(archive.ok, true)
  assert.equal(archive.sessionId, sessionId('test', 'native-1'))
  assert.equal(archive.externalSessionId, 'native-1')
  assert.equal(archive.archived, true)
  assert.equal((archive.sourceState as { availability: string }).availability, 'available')

  const restore = await router(native).request('setSessionArchived', params('native-1', false), signal) as Record<string, unknown>
  assert.deepEqual(native.calls.at(-1), { id: 'native-1', archived: false })
  assert.equal(restore.ok, true)
  assert.equal(restore.archived, false)
})

test('setSessionArchived resolves a platform-only identity through the native inventory', async () => {
  const native = new FakeNative()
  const result = await router(native).request('setSessionArchived', { sessionId: sessionId('test', 'native-1'), archived: true }, signal) as Record<string, unknown>
  assert.equal(result.ok, true)
  assert.deepEqual(native.calls, [{ id: 'native-1', archived: true }])
})

test('setSessionArchived restores a session that availability checks still reject', async () => {
  const native = new FakeNative()
  native.source.requireAvailable = async () => { throw new BridgeError('SESSION_ARCHIVED', 'archived in DSH') }
  native.source.state = async () => ({ availability: 'archived' as const, reason: 'archived_in_dsh', observedAt: 'now' })
  const result = await router(native).request('setSessionArchived', params('native-1', false), signal) as Record<string, unknown>
  assert.equal(result.ok, true)
  assert.equal(result.archived, false)
  assert.deepEqual(native.calls, [{ id: 'native-1', archived: false }])
})

test('an active native session becomes a structured session_active failure', async () => {
  const native = new FakeNative()
  native.failure = new BridgeError('SESSION_ACTIVE', 'The session is running in DSH.')
  const result = await router(native).request('setSessionArchived', params('native-1', true), signal) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session_active')
  assert.equal(result.externalSessionId, 'native-1')
  assert.equal(result.archived, true)
})

test('an unexpected native failure stays structured and mentions neither the session nor the error text', async () => {
  const native = new FakeNative()
  native.failure = new Error('secret storage path /home/me')
  const result = await router(native).request('setSessionArchived', params('native-1', true), signal) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INTERNAL_ERROR')
  assert.ok(!JSON.stringify(result).includes('secret'))
})

test('setSessionArchived rejects an invalid archive state and a foreign namespace', async () => {
  const native = new FakeNative()
  await assert.rejects(router(native).request('setSessionArchived', { sessionId: sessionId('test', 'native-1') }, signal),
    { code: 'INVALID_PARAMS' })
  await assert.rejects(router(native).request('setSessionArchived', { ...params('native-1', true), sessionId: 'sess_foreign' }, signal),
    { code: 'INVALID_PARAMS' })
  assert.deepEqual(native.calls, [])
})

test('setSessionArchived needs the native runtime', async () => {
  await assert.rejects(router(undefined).request('setSessionArchived', params('native-1', true), signal),
    { code: 'UNSUPPORTED_OPERATION' })
})

/** A real registry: the archive set is the native state AA must follow. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
  const runtime = await commandRuntime(home)
  return { home, runtime, close: async () => { await runtime.close(); await rm(home, { recursive: true, force: true }) } }
}

test('NativeRuntime archives and restores the DSH-native session', { timeout: 30_000 }, async () => {
  const { runtime, close } = await fixture()
  try {
    const { agent, params: identity } = await runtime.create('archive-native')
    const archived = await runtime.router.request('setSessionArchived', { ...identity, archived: true }, signal) as Record<string, unknown>
    assert.equal(archived.ok, true)
    assert.equal(archived.archived, true)
    assert.ok(runtime.ctx.workspaceRegistry.archivedSessionIds.includes(agent.session.id))
    assert.equal((archived.sourceState as { availability: string }).availability, 'archived')

    const restored = await runtime.router.request('setSessionArchived', { ...identity, archived: false }, signal) as Record<string, unknown>
    assert.equal(restored.ok, true)
    assert.equal(restored.archived, false)
    assert.ok(!runtime.ctx.workspaceRegistry.archivedSessionIds.includes(agent.session.id))
  } finally { await close() }
})

test('NativeRuntime reports a running session as session_active', { timeout: 30_000 }, async () => {
  const { runtime, close } = await fixture()
  try {
    const { agent, params: identity } = await runtime.create('active-native')
    const registry = runtime.ctx.workspaceRegistry as WorkspaceRegistry
    const original = registry.archiveSession
    registry.archiveSession = async () => { throw new WorkspaceActiveSessionError(SessionId('active-native'), [{ kind: 'turn' } as never]) }
    try {
      const result = await runtime.router.request('setSessionArchived', { ...identity, archived: true }, signal) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.code, 'session_active')
      assert.ok(!runtime.ctx.workspaceRegistry.archivedSessionIds.includes(agent.session.id))
    } finally { registry.archiveSession = original }
  } finally { await close() }
})
