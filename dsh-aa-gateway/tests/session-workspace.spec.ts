import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetadataStore } from '../src/bridge/persistence/metadata.js'
import { modelSelectionId, permissionSelectionId } from '../src/bridge/projection/identity.js'
import type { CatalogManager, CatalogSnapshot } from '../src/bridge/runtime/catalogs.js'
import { SessionManager } from '../src/bridge/runtime/sessions.js'

const roots: string[] = []
const model: ModelSelection = { provider: 'test', model: 'model' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('AA Session Workspace membership', () => {
  it('attaches a fresh Session to an existing Workspace and keeps committed retries idempotent', async () => {
    const fixture = await creationFixture({ existingWorkspace: true })
    const operation = createOperation(fixture.cwd)

    const first = await fixture.manager.createAndStart(operation)
    const retry = await fixture.manager.createAndStart(operation)
    const externalSessionId = receiptExternalSessionId(first)

    expect(retry).toMatchObject({ result: { externalSessionId, duplicate: true } })
    expect(fixture.resolveByPath).toHaveBeenCalledWith(fixture.cwd)
    expect(fixture.createWorkspace).not.toHaveBeenCalled()
    expect(fixture.attachSession).toHaveBeenCalledTimes(2)
    expect(fixture.workspaceSessionIds()).toEqual([externalSessionId])
    expect(fixture.createAgent).toHaveBeenCalledOnce()
    expect(fixture.followup).toHaveBeenCalledOnce()
  })

  it('creates a DSH Workspace for an unregistered selected directory before attaching', async () => {
    const fixture = await creationFixture({ existingWorkspace: false })
    const result = await fixture.manager.createAndStart(createOperation(fixture.cwd))
    const externalSessionId = receiptExternalSessionId(result)

    expect(fixture.createWorkspace).toHaveBeenCalledOnce()
    expect(fixture.createWorkspace).toHaveBeenCalledWith(fixture.cwd)
    expect(fixture.workspaceSessionIds()).toEqual([externalSessionId])
  })

  it('leaves creation recoverable when attach fails after message durability', async () => {
    const fixture = await creationFixture({ existingWorkspace: false, attachFailures: 1 })
    const operation = createOperation(fixture.cwd)

    await expect(fixture.manager.createAndStart(operation)).rejects.toMatchObject({
      data: {
        code: 'PERSISTENCE_ERROR',
        retryable: true,
        sessionId: operation.sessionId,
        details: { operation: 'workspace-attach', workspacePath: fixture.cwd },
      },
    })
    const recovered = await fixture.manager.createAndStart(operation)

    expect(recovered).toMatchObject({ result: { duplicate: true } })
    expect(fixture.attachSession).toHaveBeenCalledTimes(2)
    expect(fixture.workspaceSessionIds()).toHaveLength(1)
    expect(fixture.createAgent).toHaveBeenCalledOnce()
    expect(fixture.resumeAgent).toHaveBeenCalledOnce()
    expect(fixture.followup).toHaveBeenCalledOnce()
  })

  it('backfills only bound aa-* Sessions in newest-first order without moving native Sessions', async () => {
    const root = await workspaceRoot('backfill')
    const cwdPath = join(root, 'project')
    await mkdir(cwdPath)
    const cwd = await realpath(cwdPath)
    const metadata = new MetadataStore(join(root, 'metadata'))
    await metadata.initialize()
    await metadata.bind('platform-old', 'aa-old')
    await metadata.bind('platform-new', 'aa-new')
    await metadata.bind('platform-native', 'session-native')
    await metadata.bind('platform-no-cwd', 'aa-no-cwd')
    const headers: SessionHeader[] = [
      sessionHeader('aa-old', cwd, 1),
      sessionHeader('aa-new', cwd, 2),
      sessionHeader('session-native', cwd, 3),
      { version: 0, id: SessionId('aa-no-cwd'), createdAt: 4 },
    ]
    const existingId = SessionId('existing')
    const sessionIds: SessionId[] = [existingId]
    const attachSession = vi.fn(async (sessionId: SessionId) => {
      if (!sessionIds.includes(sessionId)) sessionIds.unshift(sessionId)
    })
    const workspace = workspaceFor(cwd, sessionIds, attachSession)
    const ctx = {
      sessionPersistence: {
        listSnapshots: () => Promise.resolve(headers.map(header => snapshot(header))),
      },
      workspaceRegistry: {
        list: () => [workspace],
        resolveByPath: () => Promise.resolve(workspace),
        create: vi.fn(),
      },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const manager = managerFor(ctx, metadata)

    await expect(manager.backfillWorkspaceMembership()).resolves.toEqual({
      attachedSessions: 2,
      skippedSessions: 1,
      failedSessions: 0,
    })
    expect(sessionIds).toEqual(['aa-new', 'aa-old', 'existing'])
    expect(sessionIds).not.toContain('session-native')
    await expect(manager.backfillWorkspaceMembership()).resolves.toEqual({
      attachedSessions: 0,
      skippedSessions: 3,
      failedSessions: 0,
    })
  })
})

interface CreationFixture {
  manager: SessionManager
  cwd: string
  resolveByPath: ReturnType<typeof vi.fn>
  createWorkspace: ReturnType<typeof vi.fn>
  attachSession: ReturnType<typeof vi.fn>
  createAgent: ReturnType<typeof vi.fn>
  resumeAgent: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  workspaceSessionIds(): string[]
}

async function creationFixture(options: {
  existingWorkspace: boolean
  attachFailures?: number
}): Promise<CreationFixture> {
  const root = await workspaceRoot('create')
  const cwdPath = join(root, 'project')
  await mkdir(cwdPath)
  const cwd = await realpath(cwdPath)
  const metadata = new MetadataStore(join(root, 'metadata'))
  await metadata.initialize()
  let header: SessionHeader | undefined
  const events: SessionEvent[] = []
  let liveAgent: Agent | undefined
  let workspace: Workspace | undefined
  let remainingAttachFailures = options.attachFailures ?? 0
  const workspaceSessionIds: SessionId[] = []
  const attachSession = vi.fn(async (sessionId: SessionId) => {
    if (remainingAttachFailures > 0) {
      remainingAttachFailures -= 1
      throw new Error('synthetic workspace persistence failure')
    }
    if (!workspaceSessionIds.includes(sessionId)) workspaceSessionIds.unshift(sessionId)
  })
  if (options.existingWorkspace) workspace = workspaceFor(cwd, workspaceSessionIds, attachSession)
  const resolveByPath = vi.fn(async () => workspace)
  const createWorkspace = vi.fn(async (path: string) => {
    workspace ??= workspaceFor(path, workspaceSessionIds, attachSession)
    return workspace
  })
  const followup = vi.fn((message: UserMessage) => {
    events.push({
      type: 'user/message',
      seq: events.length,
      time: events.length + 1,
      data: message,
    } as SessionEvent)
  })
  const makeAgent = (id: SessionId): Agent => ({
    id,
    options: { provider: model.provider, model: model.model },
    session: { id, header, events } as unknown as Agent['session'],
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
  })
  const handleFor = (agent: Agent): AgentHandle => ({
    agent,
    dispose: async () => {
      if (liveAgent === agent) liveAgent = undefined
    },
  })
  const setupContext = {
    on: () => () => undefined,
  } as unknown as Context
  const createAgent = vi.fn(async (input: {
    sessionId: SessionId
    meta: { cwd: string }
    setup?(ctx: Context): void
  }) => {
    header = sessionHeader(String(input.sessionId), input.meta.cwd, 1)
    input.setup?.(setupContext)
    liveAgent = makeAgent(input.sessionId)
    return handleFor(liveAgent)
  })
  const resumeAgent = vi.fn(async (input: { resumeSessionId: SessionId; setup?(ctx: Context): void }) => {
    input.setup?.(setupContext)
    liveAgent = makeAgent(input.resumeSessionId)
    return handleFor(liveAgent)
  })
  const catalog = catalogSnapshot()
  const catalogs = {
    current: () => Promise.resolve(catalog),
    defaultModel: () => Promise.resolve(model),
    resolveModel: () => Promise.resolve(model),
    resolvePermission: () => Promise.resolve('workspace-write'),
    permissionFor: () => permissionSelectionId('workspace-write'),
  } as unknown as CatalogManager
  const ctx = {
    agents: {
      get: () => liveAgent,
      create: createAgent,
      resume: resumeAgent,
    },
    sessions: { flush: () => Promise.resolve() },
    sessionPersistence: {
      listSnapshots: () => Promise.resolve(header === undefined ? [] : [snapshot(header)]),
      inspect: () => {
        if (header === undefined) throw new Error('Session does not exist')
        return Promise.resolve({ meta: header, events })
      },
    },
    workspaceRegistry: {
      list: () => workspace === undefined ? [] : [workspace],
      resolveByPath,
      create: createWorkspace,
      archivedSessionIds: [],
    },
    permissionPresets: {
      current: () => 'workspace-write',
      set: vi.fn(),
      defaultPreset: 'workspace-write',
    },
    llm: { listProviders: () => [{ id: model.provider }] },
    logger: { warn: vi.fn() },
  } as unknown as Context
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
    cwd,
    resolveByPath,
    createWorkspace,
    attachSession,
    createAgent,
    resumeAgent,
    followup,
    workspaceSessionIds: () => workspaceSessionIds.map(String),
  }
}

function managerFor(ctx: Context, metadata: MetadataStore): SessionManager {
  return new SessionManager(
    ctx,
    metadata,
    {} as CatalogManager,
    10,
    10,
    () => undefined,
    () => undefined,
    () => undefined,
  )
}

function createOperation(cwd: string): Parameters<SessionManager['createAndStart']>[0] {
  return {
    sessionId: 'platform-create',
    content: 'hello',
    clientMessageId: 'create-message',
    cwd,
    attachments: [],
  }
}

function receiptExternalSessionId(receipt: Record<string, unknown>): string {
  const result = receipt.result as Record<string, unknown>
  if (typeof result.externalSessionId !== 'string') throw new Error('receipt has no external Session id')
  return result.externalSessionId
}

function workspaceFor(
  path: string,
  sessionIds: SessionId[],
  attachSession: (sessionId: SessionId) => Promise<void>,
): Workspace {
  return {
    id: 'workspace-test' as Workspace['id'],
    path,
    title: 'Workspace',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    get sessionIds() { return sessionIds },
    setTitle: () => Promise.resolve(),
    attachSession,
    insertSessionBefore: () => Promise.resolve(),
    detachSession: () => Promise.resolve(),
    status: () => Promise.resolve('ok'),
  }
}

function sessionHeader(id: string, cwd: string, createdAt: number): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt, cwd }
}

function snapshot(header: SessionHeader): SessionPersistenceSnapshot {
  return { header, revision: SessionPersistenceRevision(`jsonl:${header.id}`) }
}

function catalogSnapshot(): CatalogSnapshot {
  return {
    revision: 1,
    models: [{
      selectionId: modelSelectionId(model),
      provider: model.provider,
      model: model.model,
      reasoningEffort: null,
      name: model.model,
      enabled: true,
    }],
    permissions: [{
      selectionId: permissionSelectionId('workspace-write'),
      preset: 'workspace-write',
      name: 'workspace-write',
      enabled: true,
    }],
  }
}

async function workspaceRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `aa-bridge-workspace-${name}-`))
  roots.push(root)
  return root
}
