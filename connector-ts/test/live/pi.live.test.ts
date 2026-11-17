// Pi local-mode field test: the real pi (local npm install) + the patched @openma/pi-acp.
// Skipped by default. Run:
//   AA_LIVE_PI=1 [AA_PI_BUNDLED_RUNTIME=<prebuilt package.json + node_modules directory>] corepack yarn vitest run test/live/pi.live.test.ts
// Uses the models and login in the local ~/.pi/agent, creates a session in a temporary directory and runs two very short prompts (with one idle reclaim of the process in between).
// Browses the user's existing sessions read-only; at the end it deletes the session file this test created and checks that other session files and settings are unchanged.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { peerConnection } from '../../src/runtime/acp/handle.js'
import { recordTo, type RecordingEntry } from '../../src/runtime/acp/recording.js'
import { GUARD, piProvider, preparePiLaunch, type PiRuntimeSession } from '../../src/runtime/profiles/pi/index.js'
import { agentEnvironment } from '../../src/runtime/supervisor/environment.js'
import { AgentProcess } from '../../src/runtime/supervisor/agent-process.js'

const live = process.env.AA_LIVE_PI === '1'
const agentDir = join(homedir(), '.pi', 'agent')

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const info = statSync(path)
      if (info.isDirectory()) walk(path)
      else files.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(root)
  return files
}

async function untilTurnEnds(events: RuntimeEvent[], from: number, timeoutMs = 180_000): Promise<Extract<RuntimeEvent, { type: 'turn.ended' }>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ended = events.slice(from).find((e): e is Extract<RuntimeEvent, { type: 'turn.ended' }> => e.type === 'turn.ended')
    if (ended) return ended
    if (Date.now() > deadline) throw new Error('turn did not end')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const assistantText = (events: RuntimeEvent[], from: number): string => events.slice(from)
  .filter((e): e is Extract<RuntimeEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.role === 'assistant')
  .map(e => e.text).join('')

describe.skipIf(!live)('Pi live (local mode)', () => {
  it('browses native history read-only, runs a turn, recycles the idle process and resumes', { timeout: 600_000 }, async () => {
    const before = snapshot(agentDir)
    const work = mkdtempSync(join(tmpdir(), 'aa-pi-live-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'aa-pi-data-'))
    // Without a prebuilt package, reuse the same-manifest cache left by the v2 Desktop (if present) to skip the network download.
    const v2Cache = join(homedir(), 'Library/Application Support/Agents Anywhere/connector/pi-npm-runtimes/2a767d2905f93e2908db')
    const bundle = process.env.AA_PI_BUNDLED_RUNTIME ?? (existsSync(v2Cache) ? v2Cache : undefined)
    const env = { ...process.env, AA_PI_NPM_ROOT: join(dataDir, 'npm'), ...(bundle ? { AA_PI_BUNDLED_RUNTIME: bundle } : {}) }
    const stderr: string[] = []
    const provider = piProvider({ dataDir, env, lockDir: join(dataDir, 'locks'), onStderr: (_id, line) => stderr.push(line) })
    let created: string | undefined
    try {
      const facts = await provider.discover()
      console.log('discover', JSON.stringify(facts))
      expect(facts.agentVersion).toMatch(/^1\./)

      const handle = await provider.start({ instanceId: 'pi', sessionNamespace: 'live', settings: { executionMode: 'local' } })
      const page = await handle.listNativeSessions()
      console.log('native sessions', page.sessions.length)
      const existing = page.sessions[0]
      if (existing) {
        const history = await handle.readNativeHistory(existing, { limit: 20 })
        console.log('history', existing.title, history.items.length, history.olderCursor)
        expect(history.items.every(item => item.replay === true)).toBe(true)
      }

      const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_pi_live', replay: 'none' }) as PiRuntimeSession
      const events: RuntimeEvent[] = []
      void (async () => {
        for await (const event of session.events) events.push(event)
      })()
      console.log('opened', session.nativeSessionId, JSON.stringify(session.configOptions.map(o => [o.id, o.category, o.currentValue])))
      expect(session.configOptions.some(o => o.id === 'aa-permission')).toBe(true)

      const first = await session.prompt({ text: 'Reply with exactly the word: pong' }, { deliveryId: 'd1', clientMessageId: 'live-c1' })
      expect(first.outcome).toBe('accepted')
      const ended = await untilTurnEnds(events, 0)
      console.log('turn 1', ended.reason, JSON.stringify(assistantText(events, 0)))
      expect(ended.reason).toBe('end_turn')

      // idle reclaim: the process stops and the session sleeps; the next turn relaunches it with the native file (no session.lost).
      expect(await session.checkIdle(Date.now() + 24 * 3600_000)).toBe(true)
      const mark = events.length
      const second = await session.prompt({ text: 'Reply with exactly the word: pong2' }, { deliveryId: 'd2', clientMessageId: 'live-c2' })
      expect(second.outcome).toBe('accepted')
      const ended2 = await untilTurnEnds(events, mark)
      console.log('turn 2', ended2.reason, JSON.stringify(assistantText(events, mark)))
      expect(ended2.reason).toBe('end_turn')
      expect(events.some(e => e.type === 'session.lost' || e.type === 'history.reset')).toBe(false)

      const mine = (await handle.listNativeSessions()).sessions.find(s => s.nativeSessionId === session.nativeSessionId)
      expect(mine?.locator).toBeDefined()
      created = mine?.locator
      const history = await handle.readNativeHistory(mine!, { limit: 50 })
      const users = history.items.filter((i): i is Extract<RuntimeEvent, { type: 'message.completed' }> => i.type === 'message.completed' && i.role === 'user')
      console.log('own history', history.items.map(i => i.type).join(','))
      expect(users.map(u => u.clientMessageId)).toEqual(['live-c1', 'live-c2'])

      await session.close()
      await handle.stop()
    } finally {
      if (stderr.length) console.log('stderr tail', stderr.slice(-20).join('\n'))
      // delete only the session file this test created (its cwd is this test's temporary directory).
      if (created && created.startsWith(join(agentDir, 'sessions')) && readFileSync(created, 'utf8').split('\n')[0]!.includes(JSON.stringify(work).slice(1, -1))) {
        rmSync(created)
        const directory = dirname(created)
        if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true })
      }
      rmSync(work, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
    const after = snapshot(agentDir)
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path))
    console.log('changed under ~/.pi/agent', changed)
    // Pi may refresh its own login token (auth.json); existing session files and settings must stay as they were.
    expect(changed.filter(path => before.has(path) && (path.includes(`${join('agent', 'sessions')}`) || path.endsWith('settings.json')))).toEqual([])
  })
})

describe.skipIf(!live)('Pi live (aliases, attachments, interrupted messages)', () => {
  it('keeps the first native id across a restart before any write, keeps attachments and marks an interrupted message', { timeout: 600_000 }, async () => {
    const before = snapshot(agentDir)
    const work = mkdtempSync(join(tmpdir(), 'aa-pi-live2-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'aa-pi-data-'))
    const v2Cache = join(homedir(), 'Library/Application Support/Agents Anywhere/connector/pi-npm-runtimes/2a767d2905f93e2908db')
    const bundle = process.env.AA_PI_BUNDLED_RUNTIME ?? (existsSync(v2Cache) ? v2Cache : undefined)
    const env = { ...process.env, AA_PI_NPM_ROOT: join(dataDir, 'npm'), ...(bundle ? { AA_PI_BUNDLED_RUNTIME: bundle } : {}) }
    const stderr: string[] = []
    const provider = piProvider({ dataDir, env, lockDir: join(dataDir, 'locks'), onStderr: (_id, line) => stderr.push(line) })
    let created: string | undefined
    try {
      const handle = await provider.start({ instanceId: 'pi', sessionNamespace: 'live2', settings: { executionMode: 'local' } })
      const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_pi_live2', replay: 'none' }) as PiRuntimeSession
      const events: RuntimeEvent[] = []
      void (async () => {
        for await (const event of session.events) events.push(event)
      })()
      const first = session.nativeSessionId
      // reclaimed before writing a native file: on wake it can only open a new native session.
      expect(await session.checkIdle(Date.now() + 24 * 3600_000)).toBe(true)
      const notes = join(work, 'notes.txt')
      writeFileSync(notes, 'The secret word is: avocado\n')
      const info = { fileId: 'file_live_notes', name: 'notes.txt', mediaType: 'text/plain', size: 28 }
      const accepted = await session.prompt(
        { text: 'Read the attached file and reply with only the secret word.', attachments: [{ kind: 'file', path: notes, mimeType: 'text/plain', name: 'notes.txt', info }] },
        { deliveryId: 'd1', clientMessageId: 'live2-c1' },
      )
      expect(accepted.outcome).toBe('accepted')
      const ended = await untilTurnEnds(events, 0)
      console.log('turn 1', ended.reason, JSON.stringify(assistantText(events, 0)))
      expect(ended.reason).toBe('end_turn')
      expect(session.nativeSessionId).toBe(first)
      const aliases = JSON.parse(readFileSync(handle.aliases.file, 'utf8')) as { aliases: Record<string, string> }
      console.log('aliases', JSON.stringify(aliases))
      expect(Object.values(aliases.aliases)).toEqual([first])
      const user = events.find((e): e is Extract<RuntimeEvent, { type: 'message.completed' }> => e.type === 'message.completed' && e.role === 'user')
      expect(user?.timelineAttachments).toEqual([info])

      // interrupt a message that is still streaming
      const mark = events.length
      await session.prompt({ text: 'Count from 1 to 300, one number per line, nothing else.' }, { deliveryId: 'd2', clientMessageId: 'live2-c2' })
      const deadline = Date.now() + 120_000
      while (!events.slice(mark).some(e => e.type === 'message.delta' && e.role === 'assistant') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      await session.cancel()
      const ended2 = await untilTurnEnds(events, mark)
      const completed = events.slice(mark).filter((e): e is Extract<RuntimeEvent, { type: 'message.completed' }> => e.type === 'message.completed' && e.role === 'assistant')
      console.log('turn 2', ended2.reason, completed.map(e => e.status))
      expect(ended2.reason).toBe('cancelled')
      expect(completed.at(-1)?.status).toBe('cancelled')

      const mine = (await handle.listNativeSessions()).sessions.find(s => s.nativeSessionId === first)
      expect(mine?.locator).toBeDefined()
      expect(mine!.locator!.includes(first)).toBe(false)
      created = mine?.locator
      const history = await handle.readNativeHistory({ nativeSessionId: first }, { limit: 50 })
      const items = history.items.filter((i): i is Extract<RuntimeEvent, { type: 'message.completed' }> => i.type === 'message.completed')
      console.log('own history', items.map(i => `${i.role}:${i.status ?? 'done'}`).join(','))
      expect(items.find(i => i.role === 'user' && i.clientMessageId === 'live2-c1')?.timelineAttachments).toEqual([info])
      expect(items.filter(i => i.role === 'assistant').at(-1)?.status).toBe('cancelled')

      await session.close()
      await handle.stop()
    } finally {
      if (stderr.length) console.log('stderr tail', stderr.slice(-20).join('\n'))
      if (created && created.startsWith(join(agentDir, 'sessions')) && readFileSync(created, 'utf8').split('\n')[0]!.includes(JSON.stringify(work).slice(1, -1))) {
        rmSync(created)
        const directory = dirname(created)
        if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true })
      }
      rmSync(work, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
    const after = snapshot(agentDir)
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path))
    expect(changed.filter(path => before.has(path) && (path.includes(`${join('agent', 'sessions')}`) || path.endsWith('settings.json')))).toEqual([])
  })
})

// Records one real Pi interaction for the replay test (test/recordings/pi-new-prompt.jsonl). Run:
//   AA_LIVE_PI=1 AA_PI_RECORD=test/recordings/pi-new-prompt.jsonl corepack yarn vitest run test/live/pi.live.test.ts -t records
// Before recording, local paths are replaced with placeholders: home directory -> /home/user, working directory -> /workspace, guard path -> __AA_PI_GUARD__.
describe.skipIf(!live || !process.env.AA_PI_RECORD)('Pi live recording', () => {
  it('records a short turn', { timeout: 300_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), 'aa-pi-rec-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'aa-pi-data-'))
    const v2Cache = join(homedir(), 'Library/Application Support/Agents Anywhere/connector/pi-npm-runtimes/2a767d2905f93e2908db')
    const bundle = process.env.AA_PI_BUNDLED_RUNTIME ?? (existsSync(v2Cache) ? v2Cache : undefined)
    const env = { ...process.env, AA_PI_NPM_ROOT: join(dataDir, 'npm'), ...(bundle ? { AA_PI_BUNDLED_RUNTIME: bundle } : {}) }
    const entries: RecordingEntry[] = []
    const processes: AgentProcess[] = []
    const settings = { executionMode: 'local' }
    const provider = piProvider({
      dataDir, env, lockDir: join(dataDir, 'locks'),
      connect: async (environment, dialect) => {
        const launch = await preparePiLaunch({ instanceId: 'pi', sessionNamespace: 'rec', settings, dataDir }, { env })
        mkdirSync(dataDir, { recursive: true })
        const proc = new AgentProcess({ command: launch.command, args: launch.args, cwd: dataDir, env: agentEnvironment({ ...launch.environment, ...environment }, { base: env }) })
        processes.push(proc)
        recordTo(proc.peer, entry => entries.push(entry))
        return peerConnection(proc.peer, dialect)()
      },
    })
    let created: string | undefined
    try {
      const handle = await provider.start({ instanceId: 'pi', sessionNamespace: 'rec', settings })
      const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_pi_rec', replay: 'none' }) as PiRuntimeSession
      const events: RuntimeEvent[] = []
      void (async () => {
        for await (const event of session.events) events.push(event)
      })()
      expect((await session.prompt({ text: 'Reply with exactly the word: pong' }, { deliveryId: 'd1', clientMessageId: 'rec-c1' })).outcome).toBe('accepted')
      await untilTurnEnds(events, 0)
      created = (await handle.listNativeSessions()).sessions.find(s => s.nativeSessionId === session.nativeSessionId)?.locator
      await session.close()
      await handle.stop()
    } finally {
      for (const proc of processes) await proc.stop()
      if (created && created.startsWith(join(agentDir, 'sessions'))) {
        rmSync(created)
        if (readdirSync(dirname(created)).length === 0) rmSync(dirname(created), { recursive: true })
      }
    }
    const escape = (text: string): string => JSON.stringify(text).slice(1, -1)
    let text = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
    for (const [from, to] of [[escape(GUARD), '__AA_PI_GUARD__'], [escape(work), '/workspace'], [escape(dataDir), '/aa-data'], [escape(homedir()), '/home/user']] as const) text = text.replaceAll(from, to)
    // Pi's session subdirectory named after the working directory (the expanded temporary directory name)
    text = text.replace(/sessions\/--[^/"]*aa-pi-rec-[^/"]*--\//g, 'sessions/--workspace--/')
    writeFileSync(process.env.AA_PI_RECORD!, text)
    rmSync(work, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
})
