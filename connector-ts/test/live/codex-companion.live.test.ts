// Codex companion live test (skipped by default, read-only): launches a real codex-acp through the provider and probes the local Codex App read-only.
//   AA_LIVE_CODEX=1 AA_CODEX_ACP=/path/to/codex-acp/dist/index.js \
//   [AA_CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex] \
//   corepack yarn vitest run test/live/codex-companion.live.test.ts
// Opens no deeplink, sends no signal and opens no session: the opener and signaller are stand-ins that fail the test.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RuntimeHandleEvent } from '../../src/application/ports/runtime-session.js'
import { lockDirectory, resolveCodexHome } from '../../src/runtime/companions/codex/index.js'
import { codexProvider } from '../../src/runtime/profiles/codex/index.js'

const live = process.env.AA_LIVE_CODEX === '1'
const adapter = process.env.AA_CODEX_ACP ?? ''
const codexPath = process.env.AA_CODEX_PATH ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

describe.skipIf(!live)('Codex companions against the real Codex App (read-only)', () => {
  it('suggests followable App threads, inspects without resuming and plans without signalling', async () => {
    const forbidden: string[] = []
    const handle = await codexProvider({
      dataDir: mkdtempSync(join(tmpdir(), 'aa-v3-codex-companion-')),
      companion: {
        opener: async url => { forbidden.push(`open ${url}`); return false },
        signaller: {
          terminate: async p => { forbidden.push(`TERM ${p.pid}`) },
          kill: async p => { forbidden.push(`KILL ${p.pid}`) },
        },
      },
    }).start({ instanceId: 'live', sessionNamespace: 'live', settings: { cliPath: adapter, codexPath, deeplinkHandoff: false } })
    const events: RuntimeHandleEvent[] = []
    void (async () => {
      for await (const event of handle.events) events.push(event)
    })()
    try {
      // lists only codex-acp's own owner: threads of the official App are not in it.
      const owners = await handle.ipcOwnerInventory()
      console.log('ipc owners', JSON.stringify(owners).slice(0, 400))

      const locks = await lockDirectory(resolveCodexHome(undefined)).list()
      const inspected = await Promise.all(locks.slice(0, 6).map(async l => [l.threadId, await handle.inspect(l.threadId)] as const))
      for (const [id, inspection] of inspected) console.log('inspect', id, JSON.stringify(inspection))
      const followable = inspected.filter(([, i]) => i.route === 'follow').map(([id]) => id)

      // auto-follow: after the startup scan, every followable thread is suggested.
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !followable.every(id => events.some(e => e.type === 'native_session.follow_suggested' && e.ref.nativeSessionId === id))) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const suggested = events.flatMap(e => (e.type === 'native_session.follow_suggested' ? [`${e.ref.nativeSessionId}:${e.reason}`] : []))
      console.log('suggested', suggested)
      for (const id of followable) expect(suggested.some(s => s.startsWith(id))).toBe(true)

      console.log('codex app running', await handle.codexAppRunning())
      const blocked = inspected.find(([, i]) => i.route === 'blocked' && i.writerLock?.state === 'held')
      if (blocked) {
        const plan = await handle.prepareQuitCodexApp([blocked[0]])
        console.log('quit plan (not executed)', JSON.stringify(plan).slice(0, 600))
        if (plan.status === 'plan') handle.discardQuitPlan(plan.plan.planId)
      }
      const sessions = await handle.listNativeSessions()
      for (const s of sessions.sessions.slice(0, 3)) console.log('permission', s.nativeSessionId, await handle.nativePermissionSelection(s.nativeSessionId))
      expect(forbidden).toEqual([])
    } finally {
      await handle.stop()
    }
  }, 180_000)
})
