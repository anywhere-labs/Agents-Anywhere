import { randomUUID } from 'node:crypto'
import { parseImages } from './attachments.js'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { capabilities } from './capabilities.js'
import { BridgeError, publicError } from './errors.js'
import { parseSelections } from './selections.js'
import { projectHistory } from './history.js'
import { sessionId, nativeSessionId } from './identity.js'
import type { NativeRuntime } from './native.js'
import { SyncFeed, type SyncBatch } from './sync.js'
import type { TimelineItem } from './types.js'

export interface SessionReader {
  native?: NativeRuntime
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
  private feed: SyncFeed | undefined
  private inventory: Page<SessionRecord> | undefined
  private history: HistoryPage | undefined

  constructor(private readonly reader: SessionReader, readonly namespace: string,
    private notify?: (batch: SyncBatch) => void, private failed?: (error: unknown) => void) {}

  close(): void { this.feed?.close(); this.feed = undefined }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    switch (method) {
      case 'runtime.sync.subscribe': {
        if (!this.reader.native || !this.notify) throw new BridgeError('UNSUPPORTED_OPERATION', 'Event sync is unavailable.')
        this.close()
        this.feed = new SyncFeed(this.reader.native, this.namespace, this.notify, this.failed ?? (() => undefined))
        const feed = this.feed
        setTimeout(() => { if (this.feed === feed) feed.start() }, 0)
        return { streamId: feed.id, projectionVersion: 2 }
      }
      case 'runtime.sync.ack':
        if (!this.feed || params.streamId !== this.feed.id || typeof params.batchSeq !== 'number') throw new BridgeError('INVALID_PARAMS', 'Unknown event stream.')
        this.feed.ack(params.batchSeq); return { ok: true }
      case 'runtime.sync.unsubscribe': this.close(); return { ok: true }
      case 'runtime.sync.refresh': {
        // Unreadable sessions must remain addressable for an explicit retry.
        const id = await this.resolve(params, signal, true)
        if (!this.reader.native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Event sync is unavailable.')
        this.reader.native.refresh(id)
        return { accepted: true }
      }
      case 'session.createAndStart':
      case 'session.startTurn': {
        const native = this.reader.native
        if (!native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Text messaging is unavailable.')
        const attachments = parseImages(params.attachments)
        if (typeof params.sessionId !== 'string' || !params.sessionId || typeof params.content !== 'string' || typeof params.clientMessageId !== 'string') throw new BridgeError('INVALID_PARAMS', 'Session ID, text and clientMessageId are required.')
        const create = method === 'session.createAndStart'
        const id = create ? nativeSessionId(this.namespace, params.sessionId) as SessionId : await this.resolve(params, signal, true)
        try {
          await native.send(id, params.content, params.clientMessageId, typeof params.cwd === 'string' ? params.cwd : undefined, create,
            parseSelections(params.selections), typeof params.agentPreset === 'string' ? params.agentPreset : undefined, signal, attachments, params.sessionId)
        } catch (error) {
          const failure = publicError(error)
          const sourceState = await native.source.state(id)
          const configuration = native.ctx.sessions.get(id) ? await native.configuration.state(id).catch(() => undefined) : undefined
          return { ok: false, code: failure.code === 'SESSION_ARCHIVED' ? 'session_archived' : failure.code === 'SESSION_NOT_FOUND' ? 'session_unavailable' : failure.code,
            message: failure.message, result: { sessionId: params.sessionId, externalSessionId: id, sourceState,
              ...(configuration ? { configuration, created: create, messageAccepted: false } : {}) } }
        }
        return { accepted: true, sessionId: sessionId(this.namespace, id), externalSessionId: id }
      }
      case 'catalog.listModels': {
        if (!this.reader.native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Model catalog is unavailable.')
        const catalog = await this.reader.native.catalogs.models(true)
        const query = typeof params.query === 'string' ? params.query.toLocaleLowerCase() : ''
        return { ...catalog, models: catalog.models.filter(item => `${item.title} ${item.metadata.providerName} ${item.metadata.model}`.toLocaleLowerCase().includes(query))
          .slice(0, integer(params.limit, 1000, 10_000)) }
      }
      case 'catalog.listPermissions': {
        if (!this.reader.native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Permission catalog is unavailable.')
        return this.reader.native.catalogs.permissions()
      }
      case 'catalog.listAgentPresets': {
        if (!this.reader.native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Agent modes are unavailable.')
        return this.reader.native.catalogs.agentPresets()
      }
      case 'session.updateSelections': {
        const native = this.reader.native
        if (!native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Configuration changes are unavailable.')
        const id = await this.resolve(params, signal)
        const selections = parseSelections(params.selections)
        if (!Object.keys(selections).length) throw new BridgeError('INVALID_PARAMS', 'Choose a configuration to change.')
        try { await native.updateSelections(id, selections, signal) }
        catch (error) {
          const failure = publicError(error)
          return { ok: false, code: failure.code, message: failure.message,
            result: { state: await this.request('session.getState', params, new AbortController().signal).catch(() => null) } }
        }
        return { ok: true, result: { state: await this.request('session.getState', params, signal) } }
      }
      case 'session.interrupt': {
        if (!this.reader.native) throw new BridgeError('UNSUPPORTED_OPERATION', 'Interrupt is unavailable.')
        const id = await this.resolve(params, signal)
        await this.reader.native.interrupt(id)
        return { accepted: true, sessionId: sessionId(this.namespace, id), externalSessionId: id }
      }
      case 'ping': return { ok: true }
      case 'runtime.getConfig': return { runtime: 'dsh', revision: 2, values: {}, metadata: { readOnly: !this.reader.native?.ctx.get('agents'), storageMode: 'dsh-native' } }
      case 'workspace.list': return { workspaces: this.reader.native?.workspaces() ?? [] }
      case 'runtime.getCapabilities': return this.reader.native?.capabilities() ?? capabilities()
      case 'session.list': return this.list(params, signal)
      case 'session.getSnapshot': return this.snapshot(params, signal)
      case 'session.getState': {
        await this.reader.native?.source.refresh(signal)
        const id = await this.resolve(params, signal, true)
        const sourceState = await this.reader.native?.source.state(id)
        if (sourceState && sourceState.availability !== 'available') return {
          runtime: 'dsh', sessionId: sessionId(this.namespace, id), externalSessionId: id,
          status: 'blocked', selections: {}, sourceState, metadata: { readOnly: true, attached: false },
        }
        const native = await this.reader.query.readSession(id)
        const configuration = await this.reader.native?.configuration.state(id, native)
        signal.throwIfAborted()
        const lastEnd = native.events.findLast(event => event.type === 'turn/end')
        const liveStatus = this.reader.status(id)
        return { runtime: 'dsh', sessionId: sessionId(this.namespace, id), externalSessionId: id, sourceState,
          status: this.reader.native?.questions.waiting(id) ? 'waiting_approval' : liveStatus ?? (lastEnd?.data.reason.kind === 'error' ? 'error' : 'idle'), selections: configuration?.selections ?? {},
          metadata: { ...configuration?.metadata, readOnly: !this.reader.native?.ctx.get('sessionController'), attached: liveStatus !== undefined } }
      }
      case 'session.getNotices': {
        const id = await this.resolve(params, signal)
        return { notices: this.reader.native?.questions.notices(this.namespace, id) ?? [] }
      }
      case 'session.respondInteraction': {
        const id = await this.resolve(params, signal)
        if (!this.reader.native || typeof params.noticeId !== 'string' || typeof params.actionId !== 'string') throw new BridgeError('INVALID_PARAMS', 'A question and action are required.')
        return this.reader.native.questions.respond(this.namespace, id, params.noticeId, params.actionId, params.inputData)
      }
      case 'session.getCapabilities': {
        const id = await this.resolve(params, signal)
        return this.reader.native?.capabilities(sessionId(this.namespace, id), id) ?? capabilities(sessionId(this.namespace, id))
      }
      default:
        throw new BridgeError('UNSUPPORTED_OPERATION', `The DSH runtime does not support ${method}.`)
    }
  }

  private async resolve(params: Record<string, unknown>, signal: AbortSignal, includeUnavailable = false): Promise<SessionId> {
    const externalId = params.externalSessionId
    if (typeof externalId === 'string' && externalId) {
      if (params.sessionId !== undefined && params.sessionId !== sessionId(this.namespace, externalId)) {
        throw new BridgeError('INVALID_PARAMS', 'The session does not belong to this runtime namespace.')
      }
      if (this.reader.native && !includeUnavailable) {
        this.reader.native.source.retry(externalId)
        await this.reader.native.source.requireAvailable(externalId)
      }
      return externalId as SessionId
    }
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw new BridgeError('INVALID_PARAMS', 'A session identity is required.')
    if (includeUnavailable && this.reader.native) await this.reader.native.source.refresh(signal)
    const ids = includeUnavailable && this.reader.native ? this.reader.native.candidates()
      : (await this.reader.query.listSessions(signal)).map(item => item.header.id)
    const id = ids.find(id => sessionId(this.namespace, id) === params.sessionId)
    if (!id) throw new BridgeError('SESSION_NOT_FOUND', 'The DSH session is not visible.')
    if (this.reader.native && !includeUnavailable) {
      this.reader.native.source.retry(id)
      await this.reader.native.source.requireAvailable(id)
    }
    return id as SessionId
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
    const slice = page.values.slice(offset, offset + limit)
    const records = []
    for (const entry of slice) {
      if (!this.reader.native || await this.reader.native.visible(entry.header.id)) records.push(entry)
    }
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
          origin: item.header.origin ?? null, readOnly: !this.reader.native?.ctx.get('agents'),
          ...(title?.status === 'rejected' ? { titleReadFailed: true } : {}),
          // Authoritative full reads in phase one; no persistent cursor before successful ingestion.
          sync: { requires_timeline_sync: true, changed: true },
        },
      }
    })
    const next = offset + slice.length
    return { sessions, nextCursor: next < page.values.length ? `${page.id}:${next}` : null }
  }

  private async snapshot(params: Record<string, unknown>, signal: AbortSignal) {
    let offset = 0
    if (params.cursor != null) {
      if (this.reader.native && this.history && !await this.reader.native.visible(this.history.externalId)) {
        this.history = undefined
        throw new BridgeError('SESSION_NOT_FOUND', 'The session is no longer visible in DSH.')
      }
      offset = this.offset(params.cursor, this.history)
      if (params.sessionId !== this.history!.platformId ||
          (params.externalSessionId != null && params.externalSessionId !== this.history!.externalId)) {
        throw new BridgeError('INVALID_PARAMS', 'The cursor belongs to a different session.')
      }
    } else {
      const id = await this.resolve(params, signal)
      const log = this.reader.native ? await this.reader.native.read(id) : await this.reader.query.readSession(id)
      signal.throwIfAborted()
      const platformId = sessionId(this.namespace, id)
      const all = projectHistory(log, platformId)
      const limit = integer(params.limit, Math.max(all.length, 1), 1_000_000)
      const values = all.slice(-limit)
      const seq = Number(log.events.at(-1)?.seq ?? -1)
      this.history = { id: randomUUID(), values, expires: Date.now() + PAGE_LIFETIME, externalId: id,
        platformId, watermark: { seq, revision: `projection-2:${seq}` }, truncated: values.length < all.length }
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
      metadata: { projectionVersion: 2, totalItems: page.values.length, readOnly: !this.reader.native?.ctx.get('agents') },
    }
  }
}
