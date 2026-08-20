import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { InteractionManager } from '../src/bridge/runtime/interactions.js'
import type { BridgeMuxEnvelope } from '../src/bridge/control/api-frames.js'
import type { InteractionNotice } from '../src/bridge/wire/protocol.js'

function manager(emitted: InteractionNotice[]): InteractionManager {
  return new InteractionManager(
    {} as Context,
    8,
    () => undefined,
    notice => { emitted.push(notice) },
    () => undefined,
  )
}

describe('remote Web interactions', () => {
  it('projects an approval into AA and prepares the correlated Web response', async () => {
    const emitted: InteractionNotice[] = []
    const interactions = manager(emitted)
    const envelope: BridgeMuxEnvelope = {
      rpcId: 'web-approval-rpc',
      payload: {
        type: 'approval/requested',
        sessionId: SessionId('external-1'),
        approvalId: 'approval-1',
        toolName: 'shell',
        callId: 'call-1',
      },
    }
    await interactions.consumeWebEnvelope('aa-1', envelope)
    const notice = interactions.notices('aa-1')[0]
    if (notice === undefined) throw new Error('remote notice was not created')

    const prepared = interactions.prepareRemoteResponse(
      'aa-1',
      'external-1',
      notice.id,
      'allow_once',
      undefined,
    )
    expect(prepared?.message).toEqual({
      type: 'client-response',
      sessionId: 'external-1',
      rpcId: 'web-approval-rpc',
      result: {
        ok: true,
        value: { sessionId: 'external-1', approvalId: 'approval-1', outcome: 'allowed-once' },
      },
    })
    await prepared?.close()
    expect(interactions.notices('aa-1')).toEqual([])
    expect(emitted.at(-1)).toMatchObject({ id: notice.id, responseRequired: false, status: 'closed' })
  })

  it('validates a replicated question before constructing its Web answer', async () => {
    const interactions = manager([])
    await interactions.consumeWebEnvelope('aa-2', {
      rpcId: 'web-question-rpc',
      payload: {
        type: 'question/requested',
        sessionId: SessionId('external-2'),
        questions: [{
          id: 'q1',
          question: 'Choose',
          options: [{ label: 'A', description: 'first' }],
        }],
      },
    })
    const notice = interactions.notices('aa-2')[0]
    if (notice === undefined) throw new Error('remote notice was not created')

    expect(() => interactions.prepareRemoteResponse(
      'aa-2', 'external-2', notice.id, 'submit', { answers: [{ id: 'q1', selected: ['missing'] }] },
    )).toThrow(/unknown option/)
    expect(interactions.prepareRemoteResponse(
      'aa-2', 'external-2', notice.id, 'submit', { answers: [{ id: 'q1', selected: ['A'] }] },
    )?.message).toMatchObject({
      sessionId: 'external-2',
      rpcId: 'web-question-rpc',
      result: { ok: true, value: { answer: { answers: [{ id: 'q1', selected: ['A'] }] } } },
    })
  })
})
