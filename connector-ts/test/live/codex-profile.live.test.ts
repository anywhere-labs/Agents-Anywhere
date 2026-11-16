// Codex profile 实机测试（默认跳过）：经 provider 拉起真实的 codex-acp，确认 v2 Timeline ID（实时与
// `_codex/session/read` 历史一致、AA 消息认回）、v2 selection ID、计划模式与计划审阅。
//   AA_LIVE_CODEX=1 AA_CODEX_ACP=/path/to/codex-acp/dist/index.js \
//   [AA_CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex] \
//   corepack yarn vitest run test/live/codex-profile.live.test.ts
// codex-acp 需要包含 anywhere-labs/codex-acp#5（IPC v13）与 #6（`_meta.codex`）。
// 会在真实 ~/.codex 里新建线程（工作目录在临时目录），并用少量模型额度。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent, RuntimeSession } from '../../src/application/ports/runtime-session.js'
import { codexClientMessageItemId, codexPermissionSelectionId } from '../../src/domain/identity/index.js'
import { codexProvider } from '../../src/runtime/profiles/codex/index.js'

const live = process.env.AA_LIVE_CODEX === '1'
const adapter = process.env.AA_CODEX_ACP ?? ''
const codexPath = process.env.AA_CODEX_PATH ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

function collect(session: RuntimeSession): { events: RuntimeEvent[]; next: (type: RuntimeEvent['type'], timeoutMs?: number) => Promise<RuntimeEvent> } {
  const events: RuntimeEvent[] = []
  const waiters: Array<{ type: string; resolve: (e: RuntimeEvent) => void }> = []
  void (async () => {
    for await (const event of session.events) {
      events.push(event)
      for (const waiter of waiters.splice(0)) {
        if (waiter.type === event.type) waiter.resolve(event)
        else waiters.push(waiter)
      }
    }
  })()
  return {
    events,
    next: (type, timeoutMs = 240_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs)
      waiters.push({ type, resolve: e => { clearTimeout(timer); resolve(e) } })
    }),
  }
}

// 断言失败时也要停掉 codex-acp：它常驻，不停就会一直持有测试线程。
const started: Array<{ stop(): Promise<void> }> = []

async function start(prefix: string) {
  const workdir = mkdtempSync(join(tmpdir(), prefix))
  const handle = await codexProvider({ dataDir: workdir }).start({ instanceId: 'live', sessionNamespace: 'live', settings: { cliPath: adapter, codexPath } })
  started.push(handle)
  return { workdir, handle }
}

describe.skipIf(!live)('Codex profile against codex-acp', () => {
  afterEach(async () => {
    for (const handle of started.splice(0)) await handle.stop().catch(() => undefined)
  })

  it('runs a turn with v2 ids that match the native history', async () => {
    const { workdir, handle } = await start('aa-v3-codex-')
    const session = await handle.open(
      { kind: 'new', spec: { cwd: workdir, selections: { permission: codexPermissionSelectionId('request_approval', { permission_mode: 'request_approval' }) } } },
      { sessionId: 'aa_live_codex', replay: 'none' },
    )
    expect(session.configOptions.find(o => o.id === 'mode')?.currentValue).toBe('workspace-write')
    const { events, next } = collect(session)
    const ended = next('turn.ended')
    const acceptance = await session.prompt({ text: 'Reply with exactly AA-V3-CODEX-OK and nothing else. Do not use tools.' }, { deliveryId: 'd1', clientMessageId: 'aa-live-c1' })
    expect(acceptance.outcome).toBe('accepted')
    expect(await ended).toMatchObject({ reason: 'end_turn' })
    const deltas = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.role === 'assistant')
    expect(deltas.map(d => d.text).join('')).toContain('AA-V3-CODEX-OK')
    const liveId = deltas[0]!.itemId
    expect(liveId).toMatch(/^codex_item_[0-9a-f]{32}$/)
    const userId = codexClientMessageItemId(session.nativeSessionId, 'aa-live-c1')
    expect(events.find(e => e.type === 'message.completed' && e.role === 'user')).toMatchObject({ itemId: userId })

    // 原生历史（`_codex/session/read`）：同一条助手消息、同一条用户消息得到同一个 ID
    const history = await handle.readNativeHistory({ nativeSessionId: session.nativeSessionId, locator: workdir }, { limit: 50 })
    const ids = history.items.map(i => (i as { itemId?: string }).itemId)
    expect(ids).toContain(liveId)
    expect(ids).toContain(userId)

    const catalogs = await handle.catalogs()
    expect(catalogs.permissions?.permissions?.map(p => p.id)).toEqual(['request_approval', 'auto_review', 'full_access'])
    expect(handle.capabilities().items.find(c => c.id === 'session.steer')?.supported).toBe(true)
    console.log('codex live:', JSON.stringify({ thread: session.nativeSessionId, liveId, userId, historyItems: history.items.length, models: catalogs.models?.models?.map(m => m.id) }))
    await handle.stop()
  }, 400_000)

  it('plans in collaboration_mode plan and opens a plan review', async () => {
    const { workdir, handle } = await start('aa-v3-codex-plan-')
    const session = await handle.open({ kind: 'new', spec: { cwd: workdir } }, { sessionId: 'aa_live_codex_plan', replay: 'none' })
    const { events, next } = collect(session)
    await session.planning!.setMode('plan')
    expect(session.configOptions.find(o => o.id === 'collaboration_mode')?.currentValue).toBe('plan')
    const opened = next('interaction.opened', 400_000)
    await session.prompt({ text: 'Make a very short 2-step plan to create hello.txt containing HELLO in the current directory. Do not ask questions.' }, { deliveryId: 'd1', clientMessageId: 'aa-live-plan' })
    const review = await opened as Extract<RuntimeEvent, { type: 'interaction.opened' }>
    expect(review.kind).toBe('plan_review')
    expect(review.plan?.markdown.length).toBeGreaterThan(0)
    const ended = next('turn.ended', 120_000)
    await session.respond(review.interactionId, { kind: 'plan_review', action: 'dismiss' })
    await ended
    console.log('codex plan:', JSON.stringify({ plan: review.plan?.markdown.slice(0, 200), types: [...new Set(events.map(e => e.type))] }))
    await handle.stop()
  }, 600_000)
})
