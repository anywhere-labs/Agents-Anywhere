import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { record } from './types.js'

export type QuestionOutcome = { kind: 'next' } | { kind: 'result', value: unknown }
  | { kind: 'rejected', error: { name: string, code: string, message: string } }

/** A local consumer of the official Remote stream, not a replacement answer provider. */
export class QuestionStream {
  private clientId: string | undefined
  private activeContext: Context | undefined
  private dispose: () => Promise<void>
  get available(): boolean { return this.clientId !== undefined }

  constructor(ctx: Context, receive: (frame: Record<string, unknown>) => Promise<void>, changed: () => void) {
    const scope = ctx.inject(['typertGateway', 'connection', 'userQuestions'], ready => {
      const abort = new AbortController()
      const run = async () => {
        while (!abort.signal.aborted) {
          try {
            const stream = await ready.typertGateway.wireStream.open('$events', { args: {} }, abort.signal)
            for await (const value of stream) {
              if (abort.signal.aborted) break
              const frame = record(value)
              if (frame.type === 'ready' && typeof frame.clientId === 'string') {
                this.clientId = frame.clientId; this.activeContext = ready; changed()
              } else await receive(frame)
            }
          } catch { /* Gateway startup/reload is recovered by reopening its public stream. */ }
          finally { this.clientId = undefined; this.activeContext = undefined; changed() }
          try { await delay(500, undefined, { signal: abort.signal }) } catch { break }
        }
      }
      ready.effect(() => {
        const task = run()
        return async () => { abort.abort(); await task }
      }, 'dsh: user question Remote stream')
    })
    this.dispose = async () => { await scope.dispose() }
  }

  async reply(eventId: string, outcome: QuestionOutcome): Promise<void> {
    const ctx = this.activeContext, clientId = this.clientId
    if (!ctx || !clientId) throw new Error('DSH 问答连接暂不可用，请稍后重试。')
    const rpcId = randomUUID()
    // Public, already-authenticated in-process carrier. No HTTP request leaves the Host.
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: { clientId, eventId, outcome } } }),
    }))
    const envelope = record(await response.json())
    if (!response.ok || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || record(envelope.result).ok !== true) {
      throw new Error('DSH 未接收回答，请稍后重试。')
    }
  }
  async close(): Promise<void> { await this.dispose() }
}
