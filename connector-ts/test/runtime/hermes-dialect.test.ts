import { describe, expect, it } from 'vitest'

import { acpSelectionId } from '../../src/domain/identity/index.js'
import { selectionsToConfig } from '../../src/runtime/acp/config.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { hermesDialect } from '../../src/runtime/profiles/hermes/index.js'
import { FakeAcpAgent, tick } from '../support/fake-acp-agent.js'

async function hermesSession(agent: FakeAcpAgent) {
  const dialect = hermesDialect()
  const handle = new AcpRuntimeHandle({ type: 'hermes', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect) })
  const session = await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'aa_h1', replay: 'none' })
  void (async () => {
    for await (const _ of session.events) { /* drain */ }
  })()
  return { handle, session }
}

describe('Hermes dialect', () => {
  it('steers a running turn with the /steer text command', async () => {
    const agent = new FakeAcpAgent()
    let release: () => void = () => undefined
    const running = new Promise<void>(resolve => { release = resolve })
    let prompts = 0
    agent.onPrompt = async (params, a) => {
      prompts += 1
      if (prompts === 1) {
        a.text(String(params.sessionId), 'working')
        await running
      }
      return { stopReason: 'end_turn' }
    }
    const { session } = await hermesSession(agent)
    await session.prompt({ text: 'go' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    await tick()
    const steered = await session.steer!({ text: 'use tabs' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    expect(steered.outcome).toBe('injected')
    const sent = agent.received.filter(r => r.method === 'session/prompt').map(r => r.params.prompt)
    expect(sent[1]).toEqual([{ type: 'text', text: '/steer use tabs' }])
    expect(agent.received.some(r => r.method === '_session/steering')).toBe(false)

    const withFile = await session.steer!({ text: 'see file', attachments: [{ kind: 'file', path: '/w/a.txt', name: 'a.txt', mimeType: 'text/plain' }] }, { deliveryId: 'd3', clientMessageId: 'c3' })
    expect(withFile).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_argument' } })
    release()
  })

  it('needs a running turn to steer', async () => {
    const { session } = await hermesSession(new FakeAcpAgent())
    expect(await session.steer!({ text: 'x' }, { deliveryId: 'd', clientMessageId: 'c' })).toEqual({ outcome: 'prompt_required' })
  })
})

describe('creation selections (v2 merge_legacy)', () => {
  const config = [
    { id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const, currentValue: 'm1', values: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
    { id: 'effort', name: 'Effort', category: 'effort' as const, type: 'select' as const, currentValue: 'low', values: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ]

  it('decodes a model selection that carries the effort', () => {
    expect(selectionsToConfig(config, { model: acpSelectionId('m2', 'high') })).toEqual([
      { optionId: 'model', value: 'm2' },
      { optionId: 'effort', value: 'high' },
    ])
    expect(selectionsToConfig(config, { model: 'm2', permission: null })).toEqual([{ optionId: 'model', value: 'm2' }])
  })

  it('refuses conflicts, missing mappings and unknown values', () => {
    expect(() => selectionsToConfig(config, { model: acpSelectionId('m2', 'high'), effort: 'low' })).toThrow(/不一致/)
    expect(() => selectionsToConfig(config, { permission: 'ask' })).toThrow(/映射/)
    expect(() => selectionsToConfig(config, { model: 'm9' })).toThrow(/可用范围/)
    expect(() => selectionsToConfig(config, { model: 'acp-selection:@@' })).toThrow(/无效/)
  })
})
