import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { record } from './types.js'
import { quietDiagnostics, type RuntimeDiagnostics } from './diagnostics.js'

export type InteractionOutcome = { kind: 'next' } | { kind: 'result', value: unknown }
  | { kind: 'rejected', error: { name: string, code: string, message: string } }

/** Published 0.1.5 uses (endpoint, payload, signal); 0.1.7 adds uplink and peer. */
export function openInteractionEvents(wireStream: Context['typertGateway']['wireStream'], signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const open = wireStream.open
  const args: unknown[] = ['$events', { args: {} }]
  if (open.length === 5) {
    // $events is receive-only. An undefined peer selects the official in-process operator.
    args.push((async function* () {})(), undefined, signal)
  } else if (open.length === 3) {
    args.push(signal)
  } else {
    throw new Error('Unsupported DSH interaction stream signature.')
  }
  return Reflect.apply(open, wireStream, args)
}

/** A local consumer of the official Remote stream, not a replacement answer provider. */
export class InteractionStream {
  private clientId: string | undefined
  private activeContext: Context | undefined
  private dispose: () => Promise<void>
  get available(): boolean { return this.clientId !== undefined }

  constructor(ctx: Context, receive: (frame: Record<string, unknown>) => Promise<void>, changed: () => void, service: 'userQuestions' | 'approval' = 'userQuestions', diagnostics: RuntimeDiagnostics = quietDiagnostics) {
    const scope = ctx.inject(['typertGateway', 'connection', service], ready => {
      const abort = new AbortController()
      const run = async () => {
        let failed = false
        while (!abort.signal.aborted) {
          try {
            const stream = await openInteractionEvents(ready.typertGateway.wireStream, abort.signal)
            for await (const value of stream) {
              if (abort.signal.aborted) break
              const frame = record(value)
              if (frame.type === 'ready' && typeof frame.clientId === 'string') {
                if (failed) diagnostics.log('info', 'interaction.stream_recovered', { service })
                failed = false
                this.clientId = frame.clientId; this.activeContext = ready; changed()
              } else await receive(frame)
            }
          } catch (error) {
            // Report once per outage; retrying must not hide a protocol mismatch or flood logs.
            if (!abort.signal.aborted && !failed) diagnostics.log('warn', 'interaction.stream_failed', { service, openArity: ready.typertGateway.wireStream.open.length }, error)
            failed = true
          }
          finally { this.clientId = undefined; this.activeContext = undefined; changed() }
          try { await delay(500, undefined, { signal: abort.signal }) } catch { break }
        }
      }
      ready.effect(() => {
        const task = run()
        return async () => { abort.abort(); await task }
      }, 'dsh: interaction Remote stream')
    })
    this.dispose = async () => { await scope.dispose() }
  }

  async reply(eventId: string, outcome: InteractionOutcome): Promise<void> {
    const ctx = this.activeContext, clientId = this.clientId
    if (!ctx || !clientId) throw new Error('DSH 交互连接暂不可用，请稍后重试。')
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
