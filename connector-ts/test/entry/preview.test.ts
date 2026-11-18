import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ChangeNotice, ChangesPage } from '../../src/application/ports/index.js'
import { SessionFactsHub, liveFanOut } from '../../src/entry/compose.js'
import { PORT_PREVIEW_CAPABILITY, findFrpc, itemText, sessionHintsSource, watchTimelineUrls, withPortPreview } from '../../src/entry/preview.js'
import type { TimelineItem } from '../../src/domain/conversation/timeline.js'
import { MemoryChangeFeed, OutboxSignal, SessionCommandCatalog } from '../../src/sync/index.js'
import { PrintedUrls } from '../../src/workspace/index.js'

describe('sessionHintsSource', () => {
  it('lists Agent processes before terminals and leaves out the file browser scope', async () => {
    const printed = new PrintedUrls()
    printed.observe('ses_t', 'http://localhost:3000/')
    printed.observe('browse_dev', 'http://localhost:4000/')
    const hints = await sessionHintsSource({
      agents: async () => [{ pid: 100, sessionIds: ['ses_busy', 'ses_idle'] }, { pid: 101, sessionIds: [] }],
      terminals: () => [{ pid: 100, sessionId: 'ses_t' }, { pid: 200, sessionId: 'ses_t' }, { pid: 300, sessionId: 'browse_dev' }],
      printed,
      isSession: sessionId => sessionId !== 'browse_dev',
    })()
    expect([...hints.roots]).toEqual([[100, 'ses_busy'], [200, 'ses_t']])
    expect([...hints.mentioned.keys()]).toEqual([3000])
  })
})

describe('withPortPreview', () => {
  it('adds the session capability, unavailable without frpc', () => {
    const set = { revision: 3, capabilities: [{ capabilityId: 'session.interrupt', supported: true, runtime: 'claude', scope: 'session' as const, sessionId: 'ses_a' }] }
    expect(withPortPreview(set, true, { runtime: 'claude', sessionId: 'ses_a' }).capabilities).toEqual([
      set.capabilities[0],
      { capabilityId: PORT_PREVIEW_CAPABILITY, supported: true, available: true, runtime: 'claude', scope: 'session', sessionId: 'ses_a' },
    ])
    const unavailable = withPortPreview(withPortPreview(set, true, { runtime: 'claude', sessionId: 'ses_a' }), false, { runtime: 'claude', sessionId: 'ses_a' })
    expect(unavailable.revision).toBe(3)
    expect(unavailable.capabilities!.filter(item => item.capabilityId === PORT_PREVIEW_CAPABILITY)).toEqual([
      { capabilityId: PORT_PREVIEW_CAPABILITY, supported: true, available: false, unavailableReason: 'preview_unavailable', runtime: 'claude', scope: 'session', sessionId: 'ses_a' },
    ])
  })

  it('is added to a session\'s capabilities.changed on the live fan-out, not to runtime-scoped sets', () => {
    const forwarded: Record<string, unknown>[] = []
    const live = liveFanOut({
      sessionCommands: new SessionCommandCatalog(),
      sessionFacts: new SessionFactsHub(),
      outboxSignal: new OutboxSignal(),
      attach: () => ({ emit: (_method, payload) => forwarded.push(payload) }),
      sessionCapabilities: (set, scope) => withPortPreview(set, false, scope),
    })
    const capabilities = { revision: 1, capabilities: [{ capabilityId: 'session.interrupt', supported: true, runtime: 'codex', scope: 'session' as const, sessionId: 'ses_a' }] }
    live.emit('runtime.status', { runtimeId: 'codex', sessionId: 'ses_a', status: { event: 'capabilities.changed' }, capabilities })
    live.emit('runtime.status', { runtimeId: 'codex', status: { event: 'capabilities.changed' }, capabilities })
    const ids = (payload: Record<string, unknown>) => ((payload.capabilities as { capabilities: { capabilityId: string }[] }).capabilities).map(item => item.capabilityId)
    expect(ids(forwarded[0]!)).toEqual(['session.interrupt', PORT_PREVIEW_CAPABILITY])
    expect(ids(forwarded[1]!)).toEqual(['session.interrupt'])
  })
})

const tool = (seq: number, content: Record<string, unknown>, type: TimelineItem['type'] = 'tool'): TimelineItem => ({
  id: `it_${seq}`, type, status: 'done', role: type === 'tool' ? 'tool' : 'assistant', orderSeq: seq, content: content as TimelineItem['content'],
  source: { runtime: 'claude' }, createdAt: 'z', sessionId: 'ses_a', revision: 1, contentHash: 'h', updatedSeq: seq, updatedAt: 'z',
})

describe('watchTimelineUrls', () => {
  it('reads tool output committed after it started, once per item', async () => {
    const feed = new MemoryChangeFeed()
    const items = [
      tool(1, { output: 'old run: http://localhost:1111/' }),
      tool(2, { output: { stdout: ['  VITE ready', '  ➜  Local:   http://localhost:5173/'] } }),
      tool(3, { text: 'try http://localhost:2222' }, 'message'),
    ]
    const reads: number[] = []
    const timeline = {
      changesSince: async (_sessionId: string, afterSeq: number): Promise<ChangesPage> => {
        reads.push(afterSeq)
        const page = items.filter(item => item.updatedSeq > afterSeq)
        return { items: page, toSeq: page.at(-1)?.updatedSeq ?? afterSeq, resetSeq: 0, headSeq: 3, complete: true, snapshotRequired: false }
      },
    }
    const printed = new PrintedUrls()
    const stop = watchTimelineUrls({ feed, timeline, printed, delayMs: 5 })
    const notice = (fromSeq: number, toSeq: number): ChangeNotice => ({ sessionId: 'ses_a', fromSeq, toSeq, resetSeq: 0, reset: false })
    feed.publish(notice(2, 2))
    feed.publish(notice(3, 3))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect([...printed.mentioned()]).toEqual([[5173, { sessionId: 'ses_a', url: 'http://localhost:5173/' }]])
    expect(reads).toEqual([1])
    stop()
  })

  it('skips a timeline rebuild and items created before it started', async () => {
    const feed = new MemoryChangeFeed()
    const old = { ...tool(5, { output: 'http://localhost:4444/' }), createdAt: '2020-01-01T00:00:00Z' }
    const fresh = { ...tool(6, { output: 'http://localhost:5555/' }), createdAt: new Date().toISOString() }
    const reads: number[] = []
    const timeline = {
      changesSince: async (_sessionId: string, afterSeq: number): Promise<ChangesPage> => {
        reads.push(afterSeq)
        const page = [old, fresh].filter(item => item.updatedSeq > afterSeq)
        return { items: page, toSeq: page.at(-1)?.updatedSeq ?? afterSeq, resetSeq: 0, headSeq: 6, complete: true, snapshotRequired: false }
      },
    }
    const printed = new PrintedUrls()
    const stop = watchTimelineUrls({ feed, timeline, printed, delayMs: 5 })
    // A native history import rebuilds seqs 1..4: not read.
    feed.publish({ sessionId: 'ses_a', fromSeq: 1, toSeq: 4, resetSeq: 4, reset: true })
    feed.publish({ sessionId: 'ses_a', fromSeq: 5, toSeq: 6, resetSeq: 4, reset: false })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(reads).toEqual([4])
    expect([...printed.mentioned().keys()]).toEqual([5555])
    stop()
  })

  it('takes string values only, bounded', () => {
    expect(itemText({ a: 'x', b: [1, 'y', { c: 'z' }], d: null })).toBe('x\ny\nz')
    expect(itemText({ a: 'x'.repeat(100_000) }).length).toBe(64 * 1024)
  })
})

describe('findFrpc', () => {
  it('uses AA_FRPC_BINARY, then frpc on PATH, else none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-frpc-'))
    try {
      const frpc = join(dir, 'frpc')
      writeFileSync(frpc, '#!/bin/sh\n')
      chmodSync(frpc, 0o755)
      expect(findFrpc({ PATH: `/nonexistent:${dir}` }, 'darwin')).toBe(frpc)
      expect(findFrpc({ AA_FRPC_BINARY: frpc, PATH: '' }, 'darwin')).toBe(frpc)
      expect(findFrpc({ AA_FRPC_BINARY: join(dir, 'missing'), PATH: dir }, 'darwin')).toBeNull()
      expect(findFrpc({ PATH: '/nonexistent' }, 'darwin')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
