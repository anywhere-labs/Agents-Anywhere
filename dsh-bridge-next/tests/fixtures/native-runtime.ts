import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'

/** Real SDK services, no model provider, no browser, and all files in a test-owned home. */
export async function nativeRuntime(home: string, beforeHost?: (ctx: Context) => Promise<void>, seedPrefix = '') {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlPersistence, { root: join(home, 'native-sessions'), compression: 'none' }).await()
    // rc.1 persists through Agent-owned handles. Seed-only sessions have no Agent.
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    ctx.sessions.flush = async session => {
      await flush(session)
      if (session && !await ctx.sessionPersistence.stat(session.id)) {
        const handle = await ctx.sessionPersistence.create(session.header)
        try { await handle.append(session.snapshotEvents()); await handle.flush() }
        finally { await handle.close() }
      }
    }
    const query = ctx.plugin(SqliteQuery, { path: ':memory:', openAt: 'never' })
    await query.await()
    await ctx.plugin(Storage).await()
    await ctx.plugin(StorageJson, { root: join(home, 'storage') }).await()
    await ctx.plugin(StorageDomain, { backend: 'json' }).await()
    await ctx.plugin(WorkspaceRegistry).await()
    const session = ctx.sessions.create(SessionId(`${seedPrefix}native-main`), { meta: { cwd: home } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '读取当前目录' }] }), { surfaceOp: 'append' })
    session.append('session/title', { title: '官方原生会话', source: { kind: 'user' }, messageSeqs: [user.seq] })
    const callId = ToolCallId('native-bash')
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'reasoning', text: '先查看目录' }, { type: 'text', text: '我来读取。' }, { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"pwd"}' }],
    }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pwd"}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: '/test-workspace' }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    ctx.sessions.create(SessionId(`${seedPrefix}empty-native`), { meta: { cwd: home } })

    const cold = ctx.sessions.prepare(SessionId(`${seedPrefix}persisted-only`), { meta: { cwd: home, createdAt: 1 } })
    const detach = ctx.sessions.enter(cold)
    ctx.sessions.announce(cold)
    cold.append('turn/start', { turn: 1 })
    for (let i = 0; i < 1005; i++) {
      cold.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `历史 ${i}` }] }), { surfaceOp: 'append' })
    }
    cold.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(cold)
    detach()
    await ctx.plugin(TypertRegistry).await()
    await ctx.plugin(Gateway).await()
    await beforeHost?.(ctx)
    const host = await import('../../lib/index.js')
    const config = { dshHome: home, stateRoot: join(home, 'account'), connectorSourceDir: home }
    // Exercise the distributed patch through the official Loader when the writable Host is composed.
    const patches = load(await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')) as PatchOptions[]
    for (const patch of patches) for (const entry of patch.insert ?? []) {
      // Resolve the workspace package to the same exported artifact a package install provides.
      if (entry.name === '@agents-anywhere/dsh-bridge-next') entry.name = new URL('../../lib/index.js', import.meta.url).href
    }
    const plugin = ctx.get('loader')
      ? ctx.plugin(Include, { path: join(home, 'test-host.cordis.yml'), initial: [], patches: [
        ...patches, { id: 'agents-anywhere-bridge-next', config },
      ] }) : ctx.plugin(host, config)
    await plugin.await()
    if (ctx.get('loader')) await ctx.loader.await()
    return { ctx, plugin, session, query }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
