import type { MessagePort } from 'node:worker_threads'

import type { ConversationStore } from '../application/ports/index.js'
import { ConversationError, type ConversationErrorCode } from '../domain/conversation/index.js'
import { GoalConflict, GoalInvalid } from '../domain/goals/index.js'
import { PlanningConflict, PlanningInvalid } from '../domain/planning/index.js'
import { StoreError, type SyncStore } from './sqlite-store.js'

/**
 * The store's thread protocol. The worker owns SQLite and the blob files; the main thread only sends
 * `{repo, method, args}` and gets structured-cloned results back, so it never does synchronous disk I/O
 * (04-connector.md §6.1).
 */
export const REPOSITORIES = ['sessions', 'timeline', 'deliveries', 'queues', 'interactions', 'planning', 'goals', 'commands', 'outbox', 'blobs', 'kv', 'preparations'] as const
export type RepositoryName = (typeof REPOSITORIES)[number]

interface Request {
  readonly id: number
  readonly repo: RepositoryName | '$close'
  readonly method: string
  readonly args: unknown[]
}

interface SerializedError {
  readonly name: string
  readonly code: string | undefined
  readonly message: string
}

type Response =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: SerializedError }

export interface ReadyMessage {
  readonly type: 'ready'
  readonly readOnly: boolean
  readonly storeEpoch: string
  readonly methods: Readonly<Record<RepositoryName, readonly string[]>>
}

export interface FailedMessage {
  readonly type: 'failed'
  readonly error: SerializedError
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { name: error.name, code: typeof code === 'string' ? code : undefined, message: error.message }
  }
  return { name: 'Error', code: undefined, message: String(error) }
}

/** Rebuilds the domain error classes so use cases can rely on `instanceof` and `code` across the thread. */
export function reviveError(error: SerializedError): Error {
  switch (error.name) {
    case 'ConversationError':
      return new ConversationError((error.code ?? 'invalid_argument') as ConversationErrorCode, error.message)
    case 'StoreError':
      return new StoreError((error.code ?? 'not_found') as StoreError['code'], error.message)
    case 'PlanningConflict':
      return new PlanningConflict(error.message)
    case 'PlanningInvalid':
      return new PlanningInvalid(error.message)
    case 'GoalConflict':
      return new GoalConflict(error.message)
    case 'GoalInvalid':
      return new GoalInvalid(error.message)
    default: {
      const revived = new Error(error.message) as Error & { code?: string }
      revived.name = error.name
      if (error.code !== undefined) revived.code = error.code
      return revived
    }
  }
}

export function methodsOf(store: SyncStore): Record<RepositoryName, string[]> {
  const out = {} as Record<RepositoryName, string[]>
  for (const repo of REPOSITORIES) out[repo] = Object.keys(store[repo])
  return out
}

/** Serves a synchronous store on a port (worker side). */
export function serveStore(port: MessagePort, store: SyncStore, onClosed?: () => void): void {
  port.on('message', (request: Request) => {
    let response: Response
    if (request.repo === '$close') {
      try {
        store.close()
        response = { id: request.id, ok: true, value: null }
      } catch (error) {
        response = { id: request.id, ok: false, error: serializeError(error) }
      }
      port.postMessage(response)
      onClosed?.()
      return
    }
    try {
      const repository = store[request.repo] as unknown as Record<string, (...args: unknown[]) => unknown>
      const method = repository[request.method]
      if (typeof method !== 'function') throw new Error(`unknown store method ${request.repo}.${request.method}`)
      response = { id: request.id, ok: true, value: method(...request.args) }
    } catch (error) {
      response = { id: request.id, ok: false, error: serializeError(error) }
    }
    port.postMessage(response)
  })
}

export type RemoteStore = ConversationStore & { readonly readOnly: boolean; readonly storeEpoch: string }

/** The main-thread side of a channel to a served store. */
export interface StoreChannel {
  readonly store: RemoteStore
  /**
   * The store side is gone (its worker exited or crashed): every waiting call and every later one rejects with
   * `error`. Returns true when this was unexpected, false when the store was already closing or had failed.
   */
  fail(error: Error): boolean
}

/** Builds the async port on top of a channel to a served store (main-thread side). */
export function connectStore(port: MessagePort, ready: ReadyMessage, onClose?: () => Promise<void>): RemoteStore {
  return openStoreChannel(port, ready, onClose).store
}

export function openStoreChannel(port: MessagePort, ready: ReadyMessage, onClose?: () => Promise<void>): StoreChannel {
  let next = 1
  let state: 'open' | 'closing' | 'failed' = 'open'
  let failure: Error | null = null
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  port.on('message', (response: Response) => {
    const pending = waiting.get(response.id)
    if (pending === undefined) return
    waiting.delete(response.id)
    if (response.ok) pending.resolve(response.value)
    else pending.reject(reviveError(response.error))
  })
  const call = (repo: Request['repo'], method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (failure !== null) {
        reject(failure)
        return
      }
      const id = next++
      waiting.set(id, { resolve, reject })
      port.postMessage({ id, repo, method, args } satisfies Request)
    })
  const store: Record<string, unknown> = { readOnly: ready.readOnly, storeEpoch: ready.storeEpoch }
  for (const repo of REPOSITORIES) {
    const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const method of ready.methods[repo]) proxy[method] = (...args: unknown[]) => call(repo, method, args)
    store[repo] = proxy
  }
  store.close = async () => {
    const wasOpen = state === 'open'
    if (wasOpen) state = 'closing'
    if (wasOpen) await call('$close', 'close', [])
    for (const pending of waiting.values()) pending.reject(new Error('store closed'))
    waiting.clear()
    port.close()
    await onClose?.()
  }
  const fail = (error: Error): boolean => {
    const unexpected = state === 'open'
    if (failure === null) failure = error
    if (state !== 'closing') state = 'failed'
    for (const pending of waiting.values()) pending.reject(failure)
    waiting.clear()
    return unexpected
  }
  return { store: store as unknown as RemoteStore, fail }
}

/** The same async port over an in-process synchronous store (tests, short-lived tools). */
export function inProcessStore(store: SyncStore): RemoteStore {
  const out: Record<string, unknown> = { readOnly: store.readOnly, storeEpoch: store.storeEpoch }
  for (const repo of REPOSITORIES) {
    const repository = store[repo] as unknown as Record<string, (...args: unknown[]) => unknown>
    const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const method of Object.keys(repository)) {
      proxy[method] = async (...args: unknown[]) => structuredClone(repository[method]?.(...args))
    }
    out[repo] = proxy
  }
  out.close = async () => store.close()
  return out as unknown as RemoteStore
}
