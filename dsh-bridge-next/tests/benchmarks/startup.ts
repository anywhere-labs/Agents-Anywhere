import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { createUserMessage, createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { NativeRuntime } from '../../src/host/dsh-runtime/native.js'
import { SyncFeed } from '../../src/host/dsh-runtime/sync.js'

// New SDK service graph and NativeRuntime on every run; only the OS disk cache is warm.
// The receiver encodes/decodes each frame and ACKs immediately. No network/backend latency.
const oldRoot = resolve(process.argv[2]!)
const oldNative = (await import(pathToFileURL(join(oldRoot, 'native.ts')).href)).NativeRuntime as typeof NativeRuntime
const oldFeed = (await import(pathToFileURL(join(oldRoot, 'sync.ts')).href)).SyncFeed as typeof SyncFeed
const home = await mkdtemp(join(tmpdir(), 'dsh-startup-benchmark-'))
try {
  const seed = await nativeRuntime(home, async ctx => {
    const input = JSON.stringify({ command: 'x'.repeat(180_000) })
    for (let n = 0; n < 12; n++) {
      const session = ctx.sessions.prepare(SessionId(`bench-${n}`), { meta: { cwd: home, createdAt: n + 2 } })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'benchmark' }] }), { surfaceOp: 'append' })
      for (let index = 0; index < input.length; index += 60) session.append('assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: 'bash', argumentsDelta: input.slice(index, index + 60) },
      })
      session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: ToolCallId('call'), name: 'bash', arguments: input }] }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      detach()
    }
  })
  await seed.ctx.fiber.dispose()
  for (let run = 0; run < 3; run++) for (const mode of run % 2 ? ['after', 'before'] : ['before', 'after']) {
    const ctx = new Context()
    let native: NativeRuntime | undefined, feed: SyncFeed | undefined
    try {
      await ctx.plugin(SessionStore).await()
      await ctx.plugin(JsonlPersistence, { root: join(home, 'native-sessions'), compression: 'none' }).await()
      await ctx.plugin(SqliteQuery, { path: ':memory:', openAt: 'never' }).await()
      await ctx.plugin(Storage).await()
      await ctx.plugin(StorageJson, { root: join(home, 'storage') }).await()
      await ctx.plugin(StorageDomain, { backend: 'json' }).await()
      await ctx.plugin(WorkspaceRegistry).await()
      const counts = { lists: 0, persistenceLists: 0, fullReads: 0, observations: 0, parses: 0, snapshots: 0, items: 0, frames: 0 }
      const list = ctx.sessionQuery.listSessions.bind(ctx.sessionQuery)
      ctx.sessionQuery.listSessions = (...args) => { counts.lists++; return list(...args) }
      const persisted = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.list = (...args) => { counts.persistenceLists++; return persisted(...args) }
      const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
      ctx.sessionQuery.readSession = (...args) => { counts.fullReads++; return read(...args) }
      const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
      ctx.sessionQuery.observeSession = (...args) => { counts.observations++; return observe(...args) }
      native = new (mode === 'before' ? oldNative : NativeRuntime)(ctx, join(home, 'intents'))
      const lag = monitorEventLoopDelay({ resolution: 1 }); lag.enable()
      const parse = JSON.parse
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { counts.parses++; return parse(...args) }) as typeof JSON.parse
      const start = performance.now()
      try {
        await new Promise<void>((resolveDone, reject) => {
          const timer = setTimeout(() => reject(new Error('startup timeout')), 90_000)
          feed = new (mode === 'before' ? oldFeed : SyncFeed)(native!, 'benchmark', batch => {
            const wire = JSON.parse(JSON.stringify(batch))
            counts.frames++
            for (const op of wire.operations) {
              if (op.kind === 'snapshot.commit') counts.snapshots++
              if (op.kind === 'snapshot.items') counts.items += op.items.length
            }
            queueMicrotask(() => {
              feed!.ack(batch.batchSeq)
              if (wire.operations.some((op: any) => op.notifications?.some((n: any) => n.method === 'session.inventory.complete'))) {
                clearTimeout(timer); resolveDone()
              }
            })
          }, error => { clearTimeout(timer); reject(error) })
          feed.start()
        })
        console.log(JSON.stringify({ mode, run, elapsedMs: Math.round(performance.now() - start), maxLoopDelayMs: Number((lag.max / 1e6).toFixed(1)), ...counts }))
      } finally { JSON.parse = parse; lag.disable() }
    } finally { feed?.close(); await native?.close(); await ctx.fiber.dispose() }
  }
} finally { await rm(home, { recursive: true, force: true }) }
