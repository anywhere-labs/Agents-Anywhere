import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { memoryTransportPair } from '../../src/runtime/acp/jsonrpc.js'
import { parseRecording, replayPeer } from '../../src/runtime/acp/recording.js'
import { tick } from '../support/fake-acp-agent.js'

const recording = (name: string) => parseRecording(readFileSync(fileURLToPath(new URL(`../recordings/${name}`, import.meta.url)), 'utf8'))

// 通用方言：只用核心，不带 Hermes 的特殊处理。确认核心能完整走通一次真实 Agent 的交互。
const generic: AcpDialect = {
  runtime: 'hermes',
  clientCapabilities: () => ({ elicitation: { form: {} } }),
  capabilities: () => [{ id: 'session.send_message', supported: true }],
  steer: 'none',
}

describe('ACP recording replay', () => {
  it('replays a Hermes write approval end to end', async () => {
    const { peer, agent } = replayPeer(recording('hermes-allow.jsonl'), memoryTransportPair())
    const handle = new AcpRuntimeHandle({ type: 'hermes', instanceId: 'i1', dialect: generic, connect: peerConnection(peer, generic) })
    const session = await handle.open(
      { kind: 'new', spec: { cwd: '/workspace', selections: { model: 'custom:fixture', edit_approval_policy: 'ask' } } },
      { sessionId: 'aa_s1', replay: 'none' },
    )
    expect(session.nativeSessionId).toMatch(/^local-/)

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
    expect(acceptance.outcome).toBe('accepted')
    await turnEnded
    await tick(5)

    expect(agent.mismatches).toEqual([])
    expect(agent.done).toBe(true)
    const types = events.map(event => event.type)
    // session/new 之后、prompt 之前只有会话级事件（命令列表、配置），没有 Timeline 条目
    const start = types.indexOf('turn.started')
    expect(types.slice(0, start).every(t => t === 'commands.updated' || t === 'config.updated' || t === 'session.info')).toBe(true)
    expect(types).toContain('tool.started')
    expect(types).toContain('interaction.opened')
    expect(types).toContain('interaction.resolved')
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
    const reply = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta').map(e => e.text).join('')
    expect(reply.length).toBeGreaterThan(0)
    // 审批关联到它自己的 toolCallId 对应的条目。Hermes 的审批卡用独立的 toolCallId（edit-approval-1），
    // 随后用一条 tool_call_update 关闭它；v2 HermesDialect 会吞掉这条更新，交给 Hermes profile 处理，核心不做特判。
    const opened = events.find((e): e is Extract<RuntimeEvent, { type: 'interaction.opened' }> => e.type === 'interaction.opened')!
    const tools = events.filter((e): e is Extract<RuntimeEvent, { type: 'tool.started' | 'tool.updated' }> => e.type === 'tool.started' || e.type === 'tool.updated')
    expect(opened.itemId).toBeDefined()
    expect(tools.some(t => t.itemId === opened.itemId)).toBe(true)
    await handle.stop()
  })
})
