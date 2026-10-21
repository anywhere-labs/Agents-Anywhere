import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { UserApprovals } from '../../src/host/dsh-runtime/approvals.js'
import { InteractionStream } from '../../src/host/dsh-runtime/interaction-stream.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import { SyncFeed, type SyncOperation, type SyncTransport } from '../../src/host/dsh-runtime/sync.js'

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'aa-approvals-'))
  const native = await nativeRuntime(home, async ctx => {
    await mountAgents(ctx, new TextAdapter())
    await ctx.plugin(Remotes).await()
  })
  const runtime = native.ctx.agentsAnywhereRuntime.native
  await until(() => runtime.approvals.available, 'approval consumer available without userQuestions')
  const router = new RuntimeRouter({ native: runtime, query: native.ctx.sessionQuery, status: id => runtime.status(id) }, 'test')
  const request = (method: string, params: Record<string, unknown>) => router.request(method, params, new AbortController().signal)
  const handle = await native.ctx.agents.create({ sessionId: SessionId('approval-session'), agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: home } })
  const agent = handle.agent
  setApprovalPolicy(agent.session, 'ask')
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '执行受限操作' }] }), { surfaceOp: 'append' })
  const id = agent.id
  const platformId = sessionId('test', id)
  return { ...native, runtime, request, id, platformId,
    ask: (signal?: AbortSignal) => native.ctx.approval.request({ agent, toolName: 'shell', reason: '需要访问工作区之外的文件', ...(signal ? { signal } : {}) }),
    close: async () => { router.close(); await handle.dispose(); await native.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) },
  }
}

test('official restricted approval offers one-shot grant and rejection through the bridge interaction API', { timeout: 20_000 }, async () => {
  const f = await fixture()
  try {
    const capabilities = await f.request('getRuntimeCapabilities', {}) as { metadata: { approval: boolean }; capabilities: { capabilityId: string; supported: boolean }[] }
    assert.equal(capabilities.metadata.approval, true)
    assert.equal(capabilities.capabilities.find(item => item.capabilityId === 'session.interaction.approval')?.supported, true)
    for (const [action, outcome] of [['allow-once', 'allowed-once'], ['reject', 'rejected']] as const) {
      const decision = f.ask()
      await until(() => f.runtime.approvals.waiting(f.id), 'approval pending')
      const notices = await f.request('getSessionNotices', { sessionId: f.platformId }) as { notices: any[] }
      const notice = notices.notices.find(item => item.status === 'open')!
      assert.equal(notice.interactionType, 'approval')
      assert.match(notice.message, /工作区之外/)
      assert.deepEqual(notice.actions.map((item: any) => item.actionId), ['allow-once', 'reject'])
      assert.equal((await f.request('getSessionState', { sessionId: f.platformId }) as { status: string }).status, 'waiting_approval')
      assert.equal((await f.request('respondInteraction', { sessionId: sessionId('test', 'native-main'), noticeId: notice.noticeId, actionId: action }) as { ok: boolean }).ok, false)
      assert.equal((await f.request('respondInteraction', { sessionId: f.platformId, noticeId: notice.noticeId, actionId: 'allow-always' }) as { ok: boolean }).ok, false)
      const results = await Promise.all([0, 1].map(() => f.request('respondInteraction', { sessionId: f.platformId, noticeId: notice.noticeId, actionId: action }) as Promise<{ ok: boolean }>))
      assert.equal(results.filter(result => result.ok).length, 1)
      assert.equal(await decision, outcome)
      await until(() => !f.runtime.approvals.waiting(f.id), 'decision clears pending state')
      assert.equal((await f.request('respondInteraction', { sessionId: f.platformId, noticeId: notice.noticeId, actionId: action }) as { ok: boolean }).ok, false)
    }
    const decisions = f.ctx.agents.get(f.id)!.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    assert.equal(decisions.length, 2, 'native audit records exactly one result per ask')
  } finally { await f.close() }
})

test('native answer and interruption withdraw remote approval; feed reconnect restores pending notices', { timeout: 20_000 }, async () => {
  const f = await fixture()
  let eventId: string | undefined
  const nativeClient = new InteractionStream(f.ctx, async frame => { if (frame.event === 'approval/request') eventId = frame.eventId as string }, () => {}, 'approval')
  const feeds: SyncFeed[] = []
  try {
    await until(() => nativeClient.available, 'native client ready')
    const decision = f.ask()
    await until(() => f.runtime.approvals.waiting(f.id) && eventId !== undefined, 'approval is visible on both clients')
    const notice = f.runtime.approvals.notices('test', f.id).find(item => item.status === 'open')!
    for (let i = 0; i < 2; i++) {
      const batches: { operations: SyncOperation[] }[] = []
      const transport: SyncTransport = {
        async ingestBatch(batch) { batches.push(batch as unknown as { operations: SyncOperation[] }) },
        async loadCheckpoint() { return null },
        async saveCheckpoint() {},
        async deleteCheckpoint() {},
        async ingestSnapshot(_request, pages) { for await (const _page of pages) { /* drain */ } return { accepted: true } },
      }
      const feed = new SyncFeed(f.runtime, 'test', `approvals-${i}`, transport, error => assert.fail(String(error)))
      feeds.push(feed); feed.start()
      await until(() => JSON.stringify(batches).includes(notice.noticeId), 'pending approval appears in initial and reconnect feed')
      feed.close()
    }
    await nativeClient.reply(eventId!, { kind: 'result', value: 'allowed-once' })
    assert.equal(await decision, 'allowed-once')
    await until(() => !f.runtime.approvals.waiting(f.id), 'native answer closes remote notice')
    assert.equal((await f.request('respondInteraction', { sessionId: f.platformId, noticeId: notice.noticeId, actionId: 'allow-once' }) as { ok: boolean }).ok, false)
    const abort = new AbortController()
    const cancelled = f.ask(abort.signal)
    await until(() => f.runtime.approvals.waiting(f.id), 'cancelable approval')
    abort.abort()
    assert.equal(await cancelled, 'cancelled')
    await until(() => !f.runtime.approvals.waiting(f.id), 'interruption closes approval')
  } finally { for (const feed of feeds) feed.close(); await nativeClient.close(); await f.close() }
})

test('consumer replacement replays the same native approval without granting on disconnect', { timeout: 20_000 }, async () => {
  const f = await fixture()
  let replacement: UserApprovals | undefined
  try {
    const decision = f.ask()
    await until(() => f.runtime.approvals.waiting(f.id), 'pending approval')
    const originalId = f.runtime.approvals.notices('test', f.id)[0]!.noticeId
    await f.runtime.approvals.close()
    replacement = new UserApprovals(f.ctx, id => f.runtime.visible(id), () => {})
    await until(() => replacement!.waiting(f.id), 'pending approval replayed')
    assert.equal(replacement.notices('test', f.id)[0]!.noticeId, originalId)
    assert.equal((await replacement.respond('test', f.id, originalId, 'reject')).ok, true)
    assert.equal(await decision, 'rejected')
  } finally { await replacement?.close(); await f.close() }
})

test('never policy and invisible sessions cannot be granted by the remote approval consumer', { timeout: 20_000 }, async () => {
  const f = await fixture()
  let hidden: UserApprovals | undefined
  try {
    setApprovalPolicy(f.ctx.agents.get(f.id)!.session, 'never')
    assert.equal(await f.ask(), 'rejected')
    assert.equal(f.runtime.approvals.notices('test', f.id).length, 0)
    setApprovalPolicy(f.ctx.agents.get(f.id)!.session, 'ask')
    await f.runtime.approvals.close()
    hidden = new UserApprovals(f.ctx, async () => false, () => {})
    await until(() => hidden!.available, 'filtered consumer ready')
    assert.equal(await f.ask(), 'unavailable')
    assert.equal(hidden.notices('test', f.id).length, 0)
  } finally { await hidden?.close(); await f.close() }
})
