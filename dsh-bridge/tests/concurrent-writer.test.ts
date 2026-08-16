import { describe, expect, it } from 'vitest'
import { AgentsAnywhereBridge } from '../src/bridge.js'

function bridgeWithRevision(revision: () => string): AgentsAnywhereBridge {
  const ctx = {
    sessionPersistence: {
      listSnapshots: async () => [{ header: { id: 'native-1' }, revision: revision() }],
    },
    logger: { warn: () => {}, error: () => {} },
  }
  return new AgentsAnywhereBridge(ctx as never, {
    stateRoot: '/tmp/unused-aa-dsh-bridge-test',
    maxFrameBytes: 8192,
    shutdownTimeoutMs: 100,
  })
}

describe('native session writer detection', () => {
  it('rejects a revision change with the stable concurrent-writer code', async () => {
    let revision = 'rev-1'
    const bridge = bridgeWithRevision(() => revision) as unknown as {
      assertNoConcurrentWriter: (externalSessionId: string) => Promise<void>
    }

    await bridge.assertNoConcurrentWriter('native-1')
    revision = 'rev-2'

    await expect(bridge.assertNoConcurrentWriter('native-1')).rejects.toMatchObject({
      code: 'DSH_CONCURRENT_WRITER_DETECTED',
    })
  })
})
