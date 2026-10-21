import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { NativeRuntime } from '../../src/host/dsh-runtime/native.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import { mountAgents } from './agent-runtime.js'

/** Real native services with no model adapter, prompt, browser or Host server. */
export async function commandRuntime(home: string) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' }).await()
    await ctx.plugin(SqliteQuery, { path: ':memory:', openAt: 'never' }).await()
    await ctx.plugin(Storage).await()
    await ctx.plugin(StorageJson, { root: join(home, 'storage') }).await()
    await ctx.plugin(StorageDomain, { backend: 'json' }).await()
    await ctx.plugin(WorkspaceRegistry).await()
    await ctx.plugin(TypertRegistry).await()
    await ctx.plugin(Gateway).await()
    await mountAgents(ctx)
    const native = new NativeRuntime(ctx, join(home, 'create-intents'))
    const router = new RuntimeRouter({ native, query: ctx.sessionQuery, status: id => native.status(id) }, 'test')
    async function create(name: string) {
      const id = SessionId(name)
      await ctx.sessionController.create({ sessionId: id, cwd: home, agentPreset: 'minimal' })
      const agent = ctx.agents.get(id)!
      // Existing native history makes the session visible; this is not a submitted prompt.
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'seed' }] }), { surfaceOp: 'append' })
      return { agent, params: { sessionId: sessionId('test', id), externalSessionId: id } }
    }
    return { ctx, native, router, create, close: async () => { router.close(); await native.close(); await ctx.fiber.dispose() } }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
