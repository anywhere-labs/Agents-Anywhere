// Claude profile 实机测试（默认跳过）：经 provider 拉起真实的 claude-agent-acp，确认环境变量处理、
// v2 Timeline ID（实时与 JSONL 历史一致）、v2 selection ID、计划审阅。
//   AA_LIVE_CLAUDE=1 AA_CLAUDE_ACP=/path/to/node_modules/.bin/claude-agent-acp \
//   corepack yarn vitest run test/live/claude-profile.live.test.ts
// 会消耗少量模型额度；会话建在临时目录里。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent, RuntimeSession } from '../../src/application/ports/runtime-session.js'
import { claudeMessageItemId, claudePermissionSelectionId } from '../../src/domain/identity/index.js'
import { claudeProvider } from '../../src/runtime/profiles/claude/index.js'

const live = process.env.AA_LIVE_CLAUDE === '1'
const adapter = process.env.AA_CLAUDE_ACP ?? ''

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
    next: (type, timeoutMs = 180_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs)
      waiters.push({ type, resolve: e => { clearTimeout(timer); resolve(e) } })
    }),
  }
}

describe.skipIf(!live)('Claude profile against claude-agent-acp', () => {
  it('runs a turn with v2 ids that match the JSONL history', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'aa-v3-claude-'))
    const provider = claudeProvider({ dataDir: workdir })
    const handle = await provider.start({ instanceId: 'live', sessionNamespace: 'live', settings: { cliPath: adapter } })
    const session = await handle.open(
      { kind: 'new', spec: { cwd: workdir, selections: { permission: claudePermissionSelectionId('default') } } },
      { sessionId: 'aa_live_claude', replay: 'none' },
    )
    const { events, next } = collect(session)
    const ended = next('turn.ended')
    const acceptance = await session.prompt({ text: 'Reply with exactly AA-V3-CLAUDE-OK and nothing else.' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    expect(acceptance.outcome).toBe('accepted')
    expect(await ended).toMatchObject({ reason: 'end_turn' })
    const deltas = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.role === 'assistant')
    expect(deltas.map(d => d.text).join('')).toContain('AA-V3-CLAUDE-OK')
    const liveId = deltas[0]!.itemId
    expect(liveId).toMatch(/^claude_msg_[0-9a-f]{24}$/)

    // 原生历史（只读 JSONL）里同一条助手消息得到同一个 ID
    const history = await handle.readNativeHistory({ nativeSessionId: session.nativeSessionId }, { limit: 20 })
    const assistant = history.items.filter(i => i.type === 'message.completed' && i.role === 'assistant')
    expect(assistant.map(i => i.itemId)).toContain(liveId)
    expect(liveId).toBe(assistant.find(i => i.itemId === liveId)!.itemId)
    expect(claudeMessageItemId({ sessionId: 'x', externalSessionId: session.nativeSessionId }, 'unused')).toMatch(/^claude_msg_/)

    // 目录：v2 的权限 selection ID
    const catalogs = await handle.catalogs()
    expect(catalogs.permissions?.permissions?.find(p => p.id === 'acceptEdits')?.selectionId).toBe(claudePermissionSelectionId('acceptEdits'))
    expect(handle.capabilities().items.find(c => c.id === 'session.goal')?.supported).toBe(true)
    console.log('claude live:', JSON.stringify({ liveId, historyItems: history.items.length, models: catalogs.models?.models?.map(m => m.id) }))
    await handle.stop()
  }, 300_000)

  it('opens a plan review in plan mode and dismisses it', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'aa-v3-claude-plan-'))
    const handle = await claudeProvider({ dataDir: workdir }).start({ instanceId: 'live', sessionNamespace: 'live', settings: { cliPath: adapter } })
    const session = await handle.open({ kind: 'new', spec: { cwd: workdir } }, { sessionId: 'aa_live_plan', replay: 'none' })
    const { next } = collect(session)
    await session.planning!.setMode('plan')
    const opened = next('interaction.opened')
    const ended = next('turn.ended')
    await session.prompt({ text: 'Plan how to create a file named hello.txt containing "hi". Keep the plan to two short steps, then present it for approval.' }, { deliveryId: 'd', clientMessageId: 'c' })
    const review = await opened as Extract<RuntimeEvent, { type: 'interaction.opened' }>
    expect(review.kind).toBe('plan_review')
    expect(review.plan?.markdown.length).toBeGreaterThan(0)
    await session.respond(review.interactionId, { kind: 'plan_review', action: 'dismiss' })
    expect((await ended as Extract<RuntimeEvent, { type: 'turn.ended' }>).reason).toMatch(/cancelled|end_turn/)
    await handle.stop()
  }, 300_000)
})
