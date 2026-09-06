import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { join } from 'node:path'

/** Real SDK services, no model provider, no browser, and all files in a test-owned home. */
export async function nativeRuntime(home: string) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlPersistence, { root: join(home, 'native-sessions'), compression: 'none' }).await()
    const query = ctx.plugin(SqliteQuery, { path: ':memory:', openAt: 'never' })
    await query.await()
    const session = ctx.sessions.create(SessionId('native-main'), { meta: { cwd: home } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '读取当前目录' }] }), { surfaceOp: 'append' })
    session.append('session/title', { title: '官方原生会话', source: { kind: 'user' }, messageSeqs: [user.seq] })
    const callId = ToolCallId('native-bash')
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'reasoning', text: '先查看目录' }, { type: 'text', text: '我来读取。' }, { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"pwd"}' }],
    }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pwd"}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: '/test-workspace' }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    ctx.sessions.create(SessionId('empty-native'), { meta: { cwd: home } })

    const cold = ctx.sessions.prepare(SessionId('persisted-only'), { meta: { cwd: home, createdAt: 1 } })
    const detach = ctx.sessions.enter(cold)
    ctx.sessions.announce(cold)
    for (let i = 0; i < 1005; i++) {
      cold.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `历史 ${i}` }] }), { surfaceOp: 'append' })
    }
    await ctx.sessions.flush(cold)
    detach()
    await ctx.plugin(TypertRegistry).await()
    await ctx.plugin(Gateway).await()
    const host = await import('../../lib/index.js')
    const plugin = ctx.plugin(host, { dshHome: home, stateRoot: join(home, 'account'), connectorSourceDir: home, autoStart: false })
    await plugin.await()
    return { ctx, plugin, session, query }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
