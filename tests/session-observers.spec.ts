import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { afterEach, describe, expect, it } from 'vitest'
import { MetadataStore } from '../src/bridge/persistence/metadata.js'
import type { CatalogManager } from '../src/bridge/runtime/catalogs.js'
import { SessionManager } from '../src/bridge/runtime/sessions.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Session event observers', () => {
  it('contains title notification failure without rejecting the accepted rename', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 5,
      fallbackMaxBytes: 40,
      maxTitleBytes: 80,
    })
    const id = SessionId('rename-notification-failure')
    const session = ctx.sessions.create(id)
    const snapshot: SessionPersistenceSnapshot = {
      header: session.header,
      revision: SessionPersistenceRevision('jsonl:rename'),
    }
    const persistence = {
      listSnapshots: () => Promise.resolve([snapshot]),
      inspect: () => Promise.resolve({ meta: session.header, events: session.events }),
    } as unknown as Context['sessionPersistence']
    const bridgeCtx = {
      on: ctx.on.bind(ctx),
      logger: ctx.logger,
      sessions: ctx.sessions,
      sessionTitle: ctx.sessionTitle,
      sessionPersistence: persistence,
      workspaceRegistry: { archivedSessionIds: [] },
    } as unknown as Context
    const catalogs = {
      defaultModel: () => Promise.resolve({ provider: 'test', model: 'test' }),
      permissionFor: () => 'default',
    } as unknown as CatalogManager
    const root = await mkdtemp(join(tmpdir(), 'aa-bridge-observers-'))
    roots.push(root)
    const metadata = new MetadataStore(root)
    await metadata.initialize()
    const manager = new SessionManager(
      bridgeCtx,
      metadata,
      catalogs,
      10,
      10,
      () => Promise.reject(new Error('connector output failed')),
      () => undefined,
      () => undefined,
    )
    await manager.state('platform-session', String(id))
    const dispose = manager.registerObservers()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      const accepted = ctx.sessionTitle.rename(session, '  renamed safely  ')
      expect(accepted.title).toBe('renamed safely')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      expect(warnings.some(message => message.includes('session/event listener rejected')
        && message.includes('connector output failed'))).toBe(true)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      dispose()
    }
  })
})
