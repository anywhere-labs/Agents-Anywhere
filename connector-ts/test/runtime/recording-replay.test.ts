import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { memoryTransportPair } from '../../src/runtime/acp/jsonrpc.js'
import { parseRecording, replayPeer } from '../../src/runtime/acp/recording.js'
import { genericDialect } from '../../src/runtime/profiles/generic/dialect.js'
import { HERMES, hermesDialect } from '../../src/runtime/profiles/hermes/index.js'
import { tick } from '../support/fake-acp-agent.js'

const recording = (name: string) => parseRecording(readFileSync(fileURLToPath(new URL(`../recordings/${name}`, import.meta.url)), 'utf8'))

type Opened = Extract<RuntimeEvent, { type: 'interaction.opened' }>
type Tool = Extract<RuntimeEvent, { type: 'tool.started' | 'tool.updated' }>

/** 回放 Hermes 写入审批：新建会话 → 两项初始选择 → prompt → 允许一次 → 回复。 */
async function replayHermesAllow(dialect: AcpDialect, selections: Record<string, string>) {
  const { peer, agent } = replayPeer(recording('hermes-allow.jsonl'), memoryTransportPair())
  const handle = new AcpRuntimeHandle({
    type: 'hermes', instanceId: 'i1', dialect, connect: peerConnection(peer, dialect),
    ...(HERMES.permissionOptions ? { permissionOptions: HERMES.permissionOptions } : {}),
  })
  const session = await handle.open({ kind: 'new', spec: { cwd: '/workspace', selections } }, { sessionId: 'aa_s1', replay: 'none' })
  const events: RuntimeEvent[] = []
  let ended: () => void = () => undefined
  const turnEnded = new Promise<void>(resolve => { ended = resolve })
  void (async () => {
    for await (const event of session.events) {
      events.push(event)
      if (event.type === 'interaction.opened') {
        const allow = event.options?.find(option => option.kind === 'allow_once')
        await session.respond(event.interactionId, { kind: 'option', optionId: allow!.id })
      }
      if (event.type === 'turn.ended') ended()
    }
  })()
  const acceptance = await session.prompt({ text: 'Write the proof file.' }, { deliveryId: 'd1', clientMessageId: 'first' })
  await turnEnded
  await tick(5)
  return { handle, session, agent, events, acceptance }
}

describe('ACP recording replay: Hermes write approval', () => {
  it('runs end to end on the generic dialect', async () => {
    const { handle, session, agent, events, acceptance } = await replayHermesAllow(genericDialect('hermes'), { model: 'custom:fixture', mode: 'ask' })
    expect(session.nativeSessionId).toMatch(/^local-/)
    expect(acceptance.outcome).toBe('accepted')
    expect(agent.mismatches).toEqual([])
    expect(agent.done).toBe(true)
    const types = events.map(event => event.type)
    // session/new 之后、prompt 之前只有会话级事件（命令列表、配置），没有 Timeline 条目
    const start = types.indexOf('turn.started')
    expect(types.slice(0, start).every(t => t === 'commands.updated' || t === 'config.updated' || t === 'session.info')).toBe(true)
    expect(types).toContain('tool.started')
    expect(types).toContain('interaction.resolved')
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
    const reply = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta').map(e => e.text).join('')
    expect(reply.length).toBeGreaterThan(0)
    // Hermes 的审批卡用独立的 toolCallId（edit-approval-1），在请求之前没出现过：不关联条目。
    // 通用方言下，关闭卡片的 tool_call_update 会多落一个条目；Hermes 方言把它吞掉（下一个用例）。
    const opened = events.find((e): e is Opened => e.type === 'interaction.opened')!
    expect(opened.itemId).toBeUndefined()
    const tools = new Set(events.filter((e): e is Tool => e.type === 'tool.started' || e.type === 'tool.updated').map(e => e.itemId))
    expect(tools.size).toBe(2)
    await handle.stop()
  })

  it('applies the Hermes dialect: permission category, hidden approval card, steer by /steer', async () => {
    const { handle, session, agent, events } = await replayHermesAllow(hermesDialect(), { model: 'custom:fixture', permission: 'ask' })
    expect(agent.mismatches).toEqual([])
    expect(agent.done).toBe(true)
    // 编辑审批策略从 mode 改到 permission 类别，所以 `permission` 选择能落到它上面
    expect(session.configOptions.find(o => o.id === 'edit_approval_policy')?.category).toBe('permission')
    // 关闭审批卡的更新被吞掉：只剩真正的工具调用一个条目
    const tools = new Set(events.filter((e): e is Tool => e.type === 'tool.started' || e.type === 'tool.updated').map(e => e.itemId))
    expect(tools.size).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
    // 建会话前的权限目录来自定义
    const catalogs = await handle.catalogs()
    expect(catalogs.permissions?.permissions?.map(p => p.selectionId)).toEqual(['ask', 'workspace_session', 'session'])
    expect(handle.capabilities().items.find(c => c.id === 'session.steer')?.supported).toBe(true)
    await handle.stop()
  })
})
