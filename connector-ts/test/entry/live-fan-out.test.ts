import { describe, expect, it } from 'vitest'

import type { EventMethod, LiveEventPayloads } from '../../src/application/ports/index.js'
import { SessionFactsHub, liveFanOut } from '../../src/entry/compose.js'
import { AttachHub } from '../../src/link/attach.js'
import { OutboxSignal, SessionCommandCatalog } from '../../src/sync/index.js'

const COMMANDS_UPDATED = {
  runtimeId: 'rti_pi',
  sessionId: 'sess_1',
  status: { event: 'commands.updated', commands: [{ name: 'review', description: 'Review the diff' }] },
} as const satisfies LiveEventPayloads['runtime.status']

describe('the device live fan-out', () => {
  it('keeps slash commands a Runtime reports before the link exists', () => {
    const sessionCommands = new SessionCommandCatalog()
    let attach: AttachHub | null = null
    const live = liveFanOut({ sessionCommands, sessionFacts: new SessionFactsHub(), outboxSignal: new OutboxSignal(), attach: () => attach })
    // A session resumed while the Connector starts reports its commands; no link yet.
    live.emit('runtime.status', COMMANDS_UPDATED)
    attach = new AttachHub()
    expect(sessionCommands.get('sess_1')).toEqual([{ name: 'review', description: 'Review the diff' }])
  })

  it('also keeps them in encrypted mode, where attach drops session facts, and still publishes to channel subscribers', () => {
    const sessionCommands = new SessionCommandCatalog()
    const sessionFacts = new SessionFactsHub()
    const attach = new AttachHub()
    attach.setMode('required')
    const seen: { method: string; payload: Record<string, unknown> }[] = []
    sessionFacts.subscribe('sess_1', (method, payload) => seen.push({ method, payload }))
    const forwarded: EventMethod[] = []
    const live = liveFanOut({
      sessionCommands,
      sessionFacts,
      outboxSignal: new OutboxSignal(),
      attach: () => ({ emit: (method, payload) => { forwarded.push(method); attach.emit(method, payload) } }),
    })
    live.emit('runtime.status', COMMANDS_UPDATED)
    expect(sessionCommands.get('sess_1')).toHaveLength(1)
    expect(seen).toEqual([{ method: 'runtime.status', payload: COMMANDS_UPDATED }])
    expect(forwarded).toEqual(['runtime.status'])
  })

  it('wakes the outbox on a session status change', async () => {
    const outboxSignal = new OutboxSignal()
    const live = liveFanOut({ sessionCommands: new SessionCommandCatalog(), sessionFacts: new SessionFactsHub(), outboxSignal, attach: () => null })
    live.emit('runtime.status', { runtimeId: 'rti_pi', sessionId: 'sess_1', status: { event: 'session.status', status: 'idle' } })
    // A poke while nobody waited makes the next wait return at once.
    await outboxSignal.wait(new AbortController().signal, 60_000)
  })
})
