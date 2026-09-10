import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readFile, writeFile } from 'node:fs/promises'

/** Test-owned native history that the real persistence service rejects. */
export async function corruptHistory(ctx: Context, cwd: string): Promise<void> {
  const bad = ctx.sessions.prepare(SessionId('corrupt-history'), { meta: { cwd } })
  const detach = ctx.sessions.enter(bad)
  ctx.sessions.announce(bad)
  bad.append('turn/start', { turn: 1 })
  bad.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'unreadable history' }] }), { surfaceOp: 'append' })
  bad.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(bad)
  detach()
  const path = await (ctx.sessionPersistence as import('@deepseek-ai/dsh-session-persistence-jsonl').default).resolveCurrentLog(bad.id)
  await writeFile(path!, Buffer.concat([await readFile(path!), Buffer.from(`${JSON.stringify({ seq: 1, time: Date.now(), type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })}\n`)]))
  await assert.rejects(ctx.sessionQuery.readSession(bad.id))
}
