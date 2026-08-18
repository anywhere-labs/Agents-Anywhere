import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { MetadataStore } from '../src/persistence/metadata.js'
import type { CatalogManager } from '../src/runtime/catalogs.js'
import { SessionManager } from '../src/runtime/sessions.js'
import { sessionSyncRevision, sessionVisibility } from '../src/runtime/session-visibility.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function header(id: string, origin?: 'subagent'): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 1,
    cwd: '/workspace',
    ...(origin === undefined ? {} : { origin }),
  }
}

function turnStart(seq = 0): SessionEvent {
  return { type: 'turn/start', seq, time: seq + 2, data: { turn: 1 } }
}

function userMessage(seq = 0): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq + 2,
    data: {
      id: MessageId(`message-${seq}`),
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    },
  }
}

describe('session visibility', () => {
  it('uses turn history rather than message presence to classify blank sessions', () => {
    const id = SessionId('blank')
    expect(sessionVisibility(header(id), [userMessage()], new Set())).toEqual({
      hidden: true,
      localArchived: false,
      blank: true,
      origin: null,
      hiddenReasons: ['blank'],
    })
    expect(sessionVisibility(header(id), [turnStart(), userMessage(1)], new Set())).toEqual({
      hidden: false,
      localArchived: false,
      blank: false,
      origin: null,
      hiddenReasons: [],
    })
  })

  it('reports every applicable hidden reason in deterministic order', () => {
    const item = header('child', 'subagent')
    expect(sessionVisibility(item, [], new Set([item.id]))).toEqual({
      hidden: true,
      localArchived: true,
      blank: true,
      origin: 'subagent',
      hiddenReasons: ['archived', 'blank', 'subagent'],
    })
  })

  it('changes the sync revision when only visibility changes', () => {
    const item = header('session')
    const revision = SessionPersistenceRevision('jsonl:1')
    const visible = sessionVisibility(item, [turnStart()], new Set())
    const archived = sessionVisibility(item, [turnStart()], new Set([item.id]))
    expect(sessionSyncRevision(revision, visible)).not.toBe(sessionSyncRevision(revision, archived))
    expect(sessionSyncRevision(revision, visible)).toBe(sessionSyncRevision(revision, visible))
  })
})

describe('session visibility discovery', () => {
  it('keeps the full roster, publishes visibility metadata, and invalidates stale cursors', async () => {
    const normal = header('normal')
    const archived = header('archived')
    const blank = header('blank')
    const subagent = header('subagent', 'subagent')
    const snapshots: SessionPersistenceSnapshot[] = [normal, archived, blank, subagent].map(item => ({
      header: item,
      revision: SessionPersistenceRevision(`jsonl:${item.id}`),
    }))
    const events = new Map<SessionId, SessionEvent[]>([
      [normal.id, [turnStart()]],
      [archived.id, [turnStart()]],
      [blank.id, [userMessage()]],
      [subagent.id, [turnStart()]],
    ])
    const archivedSessionIds = new Set<SessionId>([archived.id])
    const ctx = {
      sessionPersistence: {
        listSnapshots: () => Promise.resolve(snapshots),
        inspect: (id: SessionId) => Promise.resolve({
          meta: snapshots.find(item => item.header.id === id)!.header,
          events: events.get(id)!,
        }),
        readFrom: (id: SessionId, fromSeq: number) => Promise.resolve({
          meta: snapshots.find(item => item.header.id === id)!.header,
          events: events.get(id)!.filter(event => event.seq >= fromSeq),
        }),
      },
      workspaceRegistry: {
        get archivedSessionIds() { return [...archivedSessionIds] },
      },
    } as unknown as Context
    const root = await mkdtemp(join(tmpdir(), 'aa-bridge-visibility-'))
    roots.push(root)
    const metadata = new MetadataStore(root)
    await metadata.initialize()
    const manager = new SessionManager(
      ctx,
      metadata,
      {} as CatalogManager,
      10,
      10,
      () => undefined,
      () => undefined,
      () => undefined,
    )

    const listed = await manager.listSessions(10, undefined, false)
    expect(listed.sessions).toHaveLength(4)
    expect(Object.fromEntries(listed.sessions.map(item => [item.externalSessionId, item.metadata]))).toEqual({
      normal: { hidden: false, localArchived: false, blank: false, origin: null, hiddenReasons: [] },
      archived: { hidden: true, localArchived: true, blank: false, origin: null, hiddenReasons: ['archived'] },
      blank: { hidden: true, localArchived: false, blank: true, origin: null, hiddenReasons: ['blank'] },
      subagent: { hidden: true, localArchived: false, blank: false, origin: 'subagent', hiddenReasons: ['subagent'] },
    })
    expect(listed.sessions.find(item => item.externalSessionId === 'normal')?.requiresTimelineSync).toBe(true)
    expect(listed.sessions.filter(item => item.metadata.hidden).every(item => !item.requiresTimelineSync)).toBe(true)

    await metadata.bind('platform-normal', String(normal.id))
    const normalSnapshot = await manager.snapshot('platform-normal', String(normal.id), 0, 10) as {
      watermark: { revision?: string }
    }
    expect(normalSnapshot.watermark.revision)
      .toBe(listed.sessions.find(item => item.externalSessionId === 'normal')?.revision)

    const firstPage = await manager.listSessions(1, undefined, false)
    expect(firstPage.nextCursor).not.toBeNull()
    archivedSessionIds.add(normal.id)
    await expect(manager.listSessions(1, firstPage.nextCursor ?? undefined, false)).rejects.toMatchObject({
      data: { code: 'SESSION_CONFLICT' },
    })
  })
})
