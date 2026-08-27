import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetadataStore } from '../src/bridge/persistence/metadata.js'
import {
  decodeModelSelectionId,
  decodePermissionSelectionId,
  modelSelectionId,
  permissionSelectionId,
} from '../src/bridge/projection/identity.js'
import type { CatalogManager, CatalogSnapshot } from '../src/bridge/runtime/catalogs.js'
import { SessionController } from '../src/bridge/runtime/session-controller.js'
import { SessionManager } from '../src/bridge/runtime/sessions.js'

const roots: string[] = []
const originalModel: ModelSelection = { provider: 'test', model: 'alpha' }
const changedModel: ModelSelection = { provider: 'test', model: 'beta', reasoningEffort: 'high' as never }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SessionController model ownership', () => {
  it('rejects changed borrowed models, accepts idempotent values, and becomes writable when owned', async () => {
    const states: number[] = []
    const controller = new SessionController(
      SessionId('ownership'),
      'platform-ownership',
      originalModel,
      permissionSelectionId('workspace-write'),
      item => { states.push(item.state()?.revision ?? -1) },
    )
    const borrowed = agentFor(SessionId('ownership'), [])
    controller.attachBorrowed(borrowed)

    expect(controller.ownership).toBe('borrowed')
    expect(() => controller.assertModelUpdate(originalModel)).not.toThrow()
    expect(() => controller.assertModelUpdate(changedModel)).toThrowError(expect.objectContaining({
      data: {
        code: 'UNSUPPORTED_OPERATION',
        retryable: false,
        sessionId: 'platform-ownership',
        externalSessionId: 'ownership',
        details: { ownership: 'borrowed', selectionKind: 'model' },
      },
    }))

    await controller.updateSelections(originalModel, permissionSelectionId('danger-full-access'))
    expect(controller.state()?.selections).toEqual({
      model: modelSelectionId(originalModel),
      permission: permissionSelectionId('danger-full-access'),
    })
    expect(states).toEqual([1])

    await controller.detachStale()
    controller.attach({ agent: borrowed, dispose: () => Promise.resolve() })
    expect(controller.ownership).toBe('owned')
    await controller.updateSelections(changedModel)
    expect(controller.state()?.selections.model).toBe(modelSelectionId(changedModel))
    expect(states).toEqual([1, 2])
  })
})

describe('borrowed Session selection updates', () => {
  it('preflights changed models before permission writes across update, turn, and Web API entry points', async () => {
    const fixture = await borrowedFixture()
    await fixture.manager.state(fixture.platformSessionId, String(fixture.sessionId))
    const changed = modelSelectionId(changedModel)
    const requested = {
      model: changed,
      permission: permissionSelectionId('danger-full-access'),
    }

    await expect(fixture.manager.updateSelections(
      fixture.platformSessionId,
      String(fixture.sessionId),
      requested,
    )).rejects.toMatchObject({
      data: {
        code: 'UNSUPPORTED_OPERATION',
        retryable: false,
        externalSessionId: String(fixture.sessionId),
        details: { ownership: 'borrowed', selectionKind: 'model' },
      },
    })
    await expect(fixture.manager.startTurn({
      sessionId: fixture.platformSessionId,
      externalSessionId: String(fixture.sessionId),
      content: 'must not be submitted',
      clientMessageId: 'changed-model-turn',
      selections: requested,
    })).rejects.toMatchObject({ data: { code: 'UNSUPPORTED_OPERATION' } })
    await expect(fixture.manager.apiSelectModel(fixture.sessionId, changedModel))
      .rejects.toMatchObject({ data: { code: 'UNSUPPORTED_OPERATION' } })

    expect(fixture.setPermission).not.toHaveBeenCalled()
    expect(fixture.flush).not.toHaveBeenCalled()
    expect(fixture.followup).not.toHaveBeenCalled()
    expect((await fixture.manager.state(
      fixture.platformSessionId,
      String(fixture.sessionId),
    ))).toMatchObject({
      selections: {
        model: modelSelectionId(originalModel),
        permission: permissionSelectionId('workspace-write'),
      },
      revision: 0,
    })
  })

  it('accepts the observed model idempotently and applies permission-only changes', async () => {
    const fixture = await borrowedFixture()
    const idempotent = await fixture.manager.updateSelections(
      fixture.platformSessionId,
      String(fixture.sessionId),
      { model: modelSelectionId(originalModel) },
    )
    expect(idempotent).toEqual({
      ok: true,
      selections: {
        model: modelSelectionId(originalModel),
        permission: permissionSelectionId('workspace-write'),
      },
    })
    expect(fixture.setPermission).not.toHaveBeenCalled()

    const permissionOnly = await fixture.manager.updateSelections(
      fixture.platformSessionId,
      String(fixture.sessionId),
      { permission: permissionSelectionId('danger-full-access') },
    )
    expect(permissionOnly).toEqual({
      ok: true,
      selections: {
        model: modelSelectionId(originalModel),
        permission: permissionSelectionId('danger-full-access'),
      },
    })
    expect(fixture.setPermission).toHaveBeenCalledOnce()
    expect(fixture.flush).toHaveBeenCalledTimes(2)
  })

  it('reprojects a borrowed model from the latest real request header', async () => {
    const fixture = await borrowedFixture()
    await fixture.manager.state(fixture.platformSessionId, String(fixture.sessionId))
    await fixture.manager.activate(fixture.sessionId)
    fixture.events.push(requestHeaderEvent(changedModel, 1))

    await expect(fixture.manager.state(fixture.platformSessionId, String(fixture.sessionId))).resolves.toMatchObject({
      selections: { model: modelSelectionId(changedModel) },
      revision: 1,
    })
  })

  it('becomes owned after a stale borrowed Agent is resumed and routes the new model selection', async () => {
    const fixture = await borrowedFixture()
    await fixture.manager.state(fixture.platformSessionId, String(fixture.sessionId))
    fixture.detachBorrowed()
    await fixture.manager.activate(fixture.sessionId)

    await expect(fixture.manager.updateSelections(
      fixture.platformSessionId,
      String(fixture.sessionId),
      { model: modelSelectionId(changedModel) },
    )).resolves.toMatchObject({
      ok: true,
      selections: { model: modelSelectionId(changedModel) },
    })

    const assemble = fixture.scopedListeners.get('system-prompt/assemble')
    const request = fixture.scopedListeners.get('agent/request')
    if (assemble === undefined || request === undefined) throw new Error('owned selection listeners were not installed')
    await assemble(undefined, undefined, () => Promise.resolve({ variables: {} }))
    await expect(request(undefined, () => Promise.resolve({ provider: 'seed', model: 'seed' }))).resolves.toEqual({
      provider: 'test',
      model: 'beta',
      reasoningEffort: 'high',
    })
  })
})

interface BorrowedFixture {
  manager: SessionManager
  platformSessionId: string
  sessionId: SessionId
  events: SessionEvent[]
  setPermission: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  scopedListeners: Map<string, (...args: unknown[]) => unknown>
  detachBorrowed(): void
}

async function borrowedFixture(): Promise<BorrowedFixture> {
  const sessionId = SessionId('borrowed-selection')
  const platformSessionId = 'platform-borrowed-selection'
  const header: SessionHeader = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
  const events: SessionEvent[] = [requestHeaderEvent(originalModel, 0)]
  const snapshot: SessionPersistenceSnapshot = {
    header,
    revision: SessionPersistenceRevision('jsonl:borrowed-selection'),
  }
  let permission = 'workspace-write'
  let liveAgent: Agent | undefined
  const followup = vi.fn()
  const flush = vi.fn(() => Promise.resolve())
  const setPermission = vi.fn((_session: unknown, next: string) => { permission = next })
  const scopedListeners = new Map<string, (...args: unknown[]) => unknown>()
  const ownedAgent = agentFor(sessionId, events, followup)
  const borrowedAgent = agentFor(sessionId, events, followup)
  liveAgent = borrowedAgent

  const modelItems = [originalModel, changedModel].map(selection => ({
    selectionId: modelSelectionId(selection),
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort === undefined ? null : String(selection.reasoningEffort),
    name: selection.model,
    enabled: true,
  }))
  const catalogSnapshot: CatalogSnapshot = {
    revision: 1,
    models: modelItems,
    permissions: ['workspace-write', 'danger-full-access'].map(preset => ({
      selectionId: permissionSelectionId(preset),
      preset,
      name: preset,
      enabled: true,
    })),
  }
  const catalogs = {
    current: () => Promise.resolve(catalogSnapshot),
    defaultModel: () => Promise.resolve(originalModel),
    resolveModel: (id: string) => Promise.resolve(decodeModelSelectionId(id)),
    resolvePermission: (id: string) => Promise.resolve(decodePermissionSelectionId(id)),
    permissionFor: () => permissionSelectionId(permission),
  } as unknown as CatalogManager
  const agents = {
    get: () => liveAgent,
    resume: vi.fn(async (options: { setup?(ctx: Context): void }) => {
      const scopedContext = {
        on: (name: string, listener: (...args: unknown[]) => unknown) => {
          scopedListeners.set(name, listener)
          return () => { scopedListeners.delete(name) }
        },
      } as unknown as Context
      options.setup?.(scopedContext)
      liveAgent = ownedAgent
      return { agent: ownedAgent, dispose: () => Promise.resolve() } satisfies AgentHandle
    }),
  }
  const ctx = {
    agents,
    sessions: { flush },
    sessionPersistence: {
      listSnapshots: () => Promise.resolve([snapshot]),
      inspect: () => Promise.resolve({ meta: header, events }),
    },
    permissionPresets: {
      current: () => permission,
      set: setPermission,
    },
    llm: { listProviders: () => [{ id: 'test' }] },
    workspaceRegistry: { archivedSessionIds: [] },
  } as unknown as Context
  const root = await mkdtemp(join(tmpdir(), 'aa-bridge-selections-'))
  roots.push(root)
  const metadata = new MetadataStore(root)
  await metadata.initialize()
  const manager = new SessionManager(
    ctx,
    metadata,
    catalogs,
    10,
    10,
    () => undefined,
    () => undefined,
    () => undefined,
  )

  return {
    manager,
    platformSessionId,
    sessionId,
    events,
    setPermission,
    flush,
    followup,
    scopedListeners,
    detachBorrowed: () => { liveAgent = undefined },
  }
}

function agentFor(
  id: SessionId,
  events: SessionEvent[],
  followup: ReturnType<typeof vi.fn> = vi.fn(),
): Agent {
  return {
    id,
    options: { provider: originalModel.provider, model: originalModel.model },
    session: { id, events } as unknown as Agent['session'],
    inbox: { nextTurn: [], nextStep: [] } as unknown as Agent['inbox'],
    status: 'idle',
    ctx: {} as Context,
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    runMaintenance: operation => operation(new AbortController().signal),
    send: vi.fn(),
    followup,
    steer: vi.fn(),
    inject: vi.fn(),
  }
}

function requestHeaderEvent(selection: ModelSelection, seq: number): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: seq + 1,
    data: { header: { config: selection } },
  } as SessionEvent
}
