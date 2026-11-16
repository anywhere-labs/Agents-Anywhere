// 回放真实的 openma-pi-acp 0.1.8 + Pi 1.4.0 交互（test/recordings/pi-new-prompt.jsonl，由 test/live/pi.live.test.ts 录制）。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { acpFingerprint } from '../../src/domain/identity/index.js'
import { peerConnection } from '../../src/runtime/acp/handle.js'
import { memoryTransportPair } from '../../src/runtime/acp/jsonrpc.js'
import { parseRecording, replayPeer } from '../../src/runtime/acp/recording.js'
import { GUARD, normalizePiSettings, piLayout, PiRuntimeHandle } from '../../src/runtime/profiles/pi/index.js'
import { tick } from '../support/fake-acp-agent.js'

describe('ACP recording replay: Pi new session and one turn', () => {
  it('replays real openma-pi-acp traffic through the Pi profile', async () => {
    // 录制里守卫路径是占位符，换成本机的
    const text = readFileSync(fileURLToPath(new URL('../recordings/pi-new-prompt.jsonl', import.meta.url)), 'utf8')
    const entries = parseRecording(text.replaceAll('__AA_PI_GUARD__', JSON.stringify(GUARD).slice(1, -1)))
    const root = mkdtempSync(join(tmpdir(), 'aa-pi-replay-'))
    let agent: ReturnType<typeof replayPeer>['agent'] | undefined
    const settings = normalizePiSettings({ executionMode: 'local', agentDir: join(root, 'agent') }, undefined)
    const handle = new PiRuntimeHandle({
      instanceId: 'pi', settings, layout: piLayout({ dataDir: root, sessionNamespace: 'ns', instanceId: 'pi' }, settings),
      launch: () => Promise.reject(new Error('unused')),
      connect: async (_environment, dialect) => {
        const replay = replayPeer(entries, memoryTransportPair())
        agent = replay.agent
        return peerConnection(replay.peer, dialect)()
      },
      idleMs: 0, lockDir: join(root, 'locks'),
    })
    try {
      const session = await handle.open({ kind: 'new', spec: { cwd: '/workspace' } }, { sessionId: 'aa_pi', replay: 'none' })
      const events: RuntimeEvent[] = []
      let ended: () => void = () => undefined
      const turnEnded = new Promise<void>(resolve => { ended = resolve })
      void (async () => {
        for await (const event of session.events) {
          events.push(event)
          if (event.type === 'turn.ended') ended()
        }
      })()
      expect(session.configOptions.map(o => o.id)).toEqual(expect.arrayContaining(['model', 'aa-permission', 'aa-planning']))
      const acceptance = await session.prompt({ text: 'Reply with exactly the word: pong' }, { deliveryId: 'd1', clientMessageId: 'rec-c1' })
      expect(acceptance.outcome).toBe('accepted')
      await turnEnded
      await tick(5)
      const deltas = events.filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta')
      expect(deltas.map(d => d.text).join('')).toBe('pong')
      // Pi 的 messageId 稳定：条目 ID 由原生 ID 算出（v2 aaProjectionVerified）
      expect(deltas[0]!.itemId).toBe(acpFingerprint(['aa_pi', 'agent_message_chunk', '86a10990:1']))
      expect(events.at(-1)).toMatchObject({ type: 'turn.ended', reason: 'end_turn' })
      expect(events.some(e => e.type === 'usage.updated')).toBe(true)
      expect(handle.capabilities().items.find(c => c.id === 'session.steer')?.supported).toBe(true)
      await session.close()
      expect(agent?.mismatches).toEqual([])
      expect(agent?.done).toBe(true)
    } finally {
      await handle.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
