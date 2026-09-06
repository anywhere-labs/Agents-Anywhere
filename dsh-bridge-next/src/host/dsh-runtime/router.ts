import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { capabilities } from './capabilities.js'
import { BridgeError } from './errors.js'
import { projectHistory } from './history.js'
import { sessionId } from './identity.js'
import type { TimelineItem } from './types.js'

export interface SessionReader {
  query: Pick<SessionQueryEngine, 'listSessions' | 'readSession' | 'readTitleSnapshots'>
  status(id: SessionId): 'idle' | 'running' | undefined
}
interface Page<T> { id: string, values: T[], expires: number }
interface HistoryPage extends Page<TimelineItem> {
  externalId: string
  platformId: string
  watermark: { seq: number, revision: string }
  truncated: boolean
}
const PAGE_LIFETIME = 120_000

function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new BridgeError('INVALID_PARAMS', `The limit must be an integer between 1 and ${max}.`)
  }
  return value
}

/** Per-connection cursors are temporary captures, not a second persisted session store. */
export class RuntimeRouter {
  private inventory: Page<SessionRecord> | undefined
  private history: HistoryPage | undefined

  constructor(private readonly reader: SessionReader, readonly namespace: string) {}

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    switch (method) {
      case 'ping': return { ok: true }
      case 'runtime.getConfig': return { runtime: 'dsh', revision: 1, values: {}, metadata: { readOnly: true, storageMode: 'dsh-native' } }
      case 'runtime.getCapabilities': return capabilities()
      case 'session.list': return this.list(params, signal)
      case 'session.getSnapshot': return this.snapshot(params, signal)
      case 'session.getState': {
        const id = await this.resolve(params, signal)
        const native = await this.reader.query.readSession(id)
        signal.throwIfAborted()
        const lastEnd = native.events.findLast(event => event.type === 'turn/end')
        const liveStatus = this.reader.status(id)
        return { runtime: 'dsh', sessionId: sessionId(this.namespace, id), externalSessionId: id,
          status: liveStatus ?? (lastEnd?.data.reason.kind === 'error' ? 'error' : 'idle'), selections: {},
          metadata: { readOnly: true, attached: liveStatus !== undefined } }
      }
      case 'session.getNotices':
        await this.resolve(params, signal)
        return { notices: [] }
      case 'session.getCapabilities':
        return capabilities(sessionId(this.namespace, await this.resolve(params, signal)))
      default:
        throw new BridgeError('UNSUPPORTED_OPERATION', `The read-only DSH runtime does not support ${method}.`)
    }
  }

  private async resolve(params: Record<string, unknown>, signal: AbortSignal): Promise<SessionId> {
    const externalId = params.externalSessionId
    if (typeof externalId === 'string' && externalId) {
      if (params.sessionId !== undefined && params.sessionId !== sessionId(this.namespace, externalId)) {
        throw new BridgeError('INVALID_PARAMS', 'The session does not belong to this runtime namespace.')
      }
      return externalId as SessionId
    }
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw new BridgeError('INVALID_PARAMS', 'A session identity is required.')
    const records = await this.reader.query.listSessions(signal)
    const match = records.find(item => sessionId(this.namespace, item.header.id) === params.sessionId)
    if (!match) throw new BridgeError('SESSION_NOT_FOUND', 'The DSH session no longer exists.')
    return match.header.id
  }

  private offset(cursor: unknown, page: Page<unknown> | undefined): number {
    if (typeof cursor !== 'string' || !page || page.expires < Date.now()) {
      throw new BridgeError('INVALID_PARAMS', 'The read cursor expired. Start a new read.')
    }
    const [id, offset] = cursor.split(':')
    const index = Number(offset)
    if (id !== page.id || !/^\d+$/.test(offset ?? '') || !Number.isSafeInteger(index) || index < 1 || index >= page.values.length) {
      throw new BridgeError('INVALID_PARAMS', 'The read cursor is invalid.')
    }
    return index
  }

  private async list(params: Record<string, unknown>, signal: AbortSignal) {
    const limit = integer(params.limit, 100, 1000)
    let offset = 0
    if (params.cursor != null) offset = this.offset(params.cursor, this.inventory)
    else this.inventory = { id: randomUUID(), values: await this.reader.query.listSessions(signal), expires: Date.now() + PAGE_LIFETIME }
    const page = this.inventory!
    const records = page.values.slice(offset, offset + limit)
    const titles = await this.reader.query.readTitleSnapshots(records.map(item => item.header.id), signal)
    const titleById = new Map(titles.map(title => [title.sessionId, title]))
    const sessions = records.map(item => {
      const title = titleById.get(item.header.id)
      return {
        runtime: 'dsh', sessionId: sessionId(this.namespace, item.header.id), externalSessionId: item.header.id,
        title: title?.status === 'fulfilled' ? title.value.title?.title ?? null : null,
        cwd: item.header.cwd ?? null, orderingTime: new Date(item.header.createdAt).toISOString(),
        metadata: {
          live: item.live, persisted: item.persisted, parentSession: item.header.parentSession ?? null,
          origin: item.header.origin ?? null, readOnly: true,
          ...(title?.status === 'rejected' ? { titleReadFailed: true } : {}),
          // Authoritative full reads in phase one; no persistent cursor before successful ingestion.
          sync: { requires_timeline_sync: true, changed: true },
        },
      }
    })
    const next = offset + records.length
    return { sessions, nextCursor: next < page.values.length ? `${page.id}:${next}` : null }
  }

  private async snapshot(params: Record<string, unknown>, signal: AbortSignal) {
    let offset = 0
    if (params.cursor != null) {
      offset = this.offset(params.cursor, this.history)
      if (params.sessionId !== this.history!.platformId ||
          (params.externalSessionId != null && params.externalSessionId !== this.history!.externalId)) {
        throw new BridgeError('INVALID_PARAMS', 'The cursor belongs to a different session.')
      }
    } else {
      const id = await this.resolve(params, signal)
      const log = await this.reader.query.readSession(id)
      signal.throwIfAborted()
      const platformId = sessionId(this.namespace, id)
      const all = projectHistory(log, platformId)
      const limit = integer(params.limit, Math.max(all.length, 1), 1_000_000)
      const values = all.slice(-limit)
      const seq = Number(log.events.at(-1)?.seq ?? -1)
      this.history = { id: randomUUID(), values, expires: Date.now() + PAGE_LIFETIME, externalId: id,
        platformId, watermark: { seq, revision: `projection-1:${seq}` }, truncated: values.length < all.length }
    }
    const page = this.history!
    const items: TimelineItem[] = []
    let bytes = 0
    for (const item of page.values.slice(offset, offset + 1000)) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1
      if (size > 7 * 1024 * 1024) throw new BridgeError('FRAME_TOO_LARGE', 'One DSH history item exceeds the transport limit.')
      if (bytes + size > 7 * 1024 * 1024) break
      bytes += size
      items.push(item)
    }
    const next = offset + items.length
    const nextCursor = next < page.values.length ? `${page.id}:${next}` : null
    return {
      sessionId: page.platformId, externalSessionId: page.externalId, runtime: 'dsh', items,
      complete: offset === 0 && nextCursor === null && !page.truncated,
      snapshotComplete: !page.truncated, nextCursor, watermark: page.watermark,
      metadata: { projectionVersion: 1, totalItems: page.values.length, readOnly: true },
    }
  }
}
