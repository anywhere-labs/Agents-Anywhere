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

/** Replays a Hermes write approval: new session -> two initial selections -> prompt -> allow once -> reply. */
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
    // between session/new and the prompt there are only session-level events (command list, configuration), no Timeline items
    const start = types.indexOf('turn.started')
    expect(types.slice(0, start).every(t => t === 'commands.updated' || t === 'config.updated' || t === 'session.info')).toBe(true)
    expect(types).toContain('tool.started')
    expect(types).toContain('interaction.resolved')
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
    const reply = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta').map(e => e.text).join('')
    expect(reply.length).toBeGreaterThan(0)
    // Hermes's approval card uses its own toolCallId (edit-approval-1) that did not appear before the request: it is not tied to an item.
    // with the generic dialect the tool_call_update that closes the card adds an extra item; the Hermes dialect swallows it (next case).
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
    // the edit approval policy moves from the mode category to the permission category, so the `permission` selection applies to it
    expect(session.configOptions.find(o => o.id === 'edit_approval_policy')?.category).toBe('permission')
    // the update closing the approval card is swallowed: only the real tool call item remains
    const tools = new Set(events.filter((e): e is Tool => e.type === 'tool.started' || e.type === 'tool.updated').map(e => e.itemId))
    expect(tools.size).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
    // the permission catalog before session creation comes from the definition
    const catalogs = await handle.catalogs()
    expect(catalogs.permissions?.permissions?.map(p => p.selectionId)).toEqual(['ask', 'workspace_session', 'session'])
    expect(handle.capabilities().items.find(c => c.id === 'session.steer')?.supported).toBe(true)
    await handle.stop()
  })
})
