import { describe, expect, it } from 'vitest'

import { ownerGeneration } from '../../src/domain/conversation/index.js'
import { targetView } from '../../src/peer/observed.js'

describe('child session metadata', () => {
  const child = {
    id: 'child', externalSessionId: 'native-child', connectorId: 'worker', status: 'running',
    origin: { kind: 'agent', bySessionId: 'parent', byDeviceId: 'supervisor', depth: 1 },
    updatedSeq: 15, latestTurnEndSeq: 10,
  }

  it.each([
    ['device', child],
    ['Server', { session: child, serverTime: 'now' }],
  ])('preserves progress, parent and close generation from the %s response', (_, response) => {
    const view = targetView('worker', response, 'now')
    expect(view).toMatchObject({
      address: { deviceId: 'worker', sessionId: 'child' },
      createdBySessionId: 'parent',
      signal: { status: 'running', headSeq: 15, latestTurnEndSeq: 10 },
    })
    expect(ownerGeneration(view!)).toBe('native-child')
  })
})
