import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../../src/application/ports/runtime-session.js'
import { acpFingerprint, piHistoryItemId, piNativeSessionId } from '../../src/domain/identity/index.js'
import { JsonRpcError } from '../../src/runtime/acp/jsonrpc.js'
import { PiRuntimeHandle, type PiRuntimeSession } from '../../src/runtime/profiles/pi/index.js'
import { piLayout } from '../../src/runtime/profiles/pi/launch.js'
import { normalizePiSettings } from '../../src/runtime/profiles/pi/settings.js'
import { tick } from '../support/fake-acp-agent.js'
import { piWorld, writeHistory } from '../support/fake-pi-agent.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(options: { idleMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aa-pi-session-'))
  dirs.push(root)
  const agentDir = join(root, 'agent')
  const sessionsDir = join(agentDir, 'sessions', '--work--')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const settings = normalizePiSettings({ executionMode: 'local', agentDir }, undefined)
  const layout = piLayout({ dataDir: join(root, 'data'), sessionNamespace: 'ns', instanceId: 'pi' }, settings)
  mkdirSync(layout.root, { recursive: true })
  const world = piWorld(sessionsDir)
  const handle = new PiRuntimeHandle({
    instanceId: 'pi', settings, layout, launch: () => Promise.reject(new Error('not used')), connect: world.connect,
    idleMs: options.idleMs ?? 0, lockDir: join(root, 'locks'),
  })
  return { root, agentDir, sessionsDir, work, layout, world, handle }
}

function collect(session: PiRuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return events
}

const of = <T extends RuntimeEvent['type']>(events: RuntimeEvent[], type: T) => events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type)

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await tick(5)
  }
}

describe('Pi session', () => {
  it('opens with synthetic permission and plan options and applies initial selections to files', async () => {
    const { handle, layout, work } = setup()
    const session = await handle.open({ kind: 'new', spec: { cwd: work, selections: { permission: 'readonly', mode: 'plan', model: 'p/m2' } } }, { sessionId: 'aa_s1', replay: 'none' }) as PiRuntimeSession
    const options = Object.fromEntries(session.configOptions.map(o => [o.id, o.currentValue]))
    expect(options).toMatchObject({ model: 'p/m2', 'aa-permission': 'readonly', 'aa-planning': 'plan' })
    expect(JSON.parse(readFileSync(layout.permissionFile, 'utf8'))).toEqual({ [session.nativeSessionId]: 'readonly' })
    expect(existsSync(join(layout.planningDir, sha(session.nativeSessionId)))).toBe(true)
    expect(session.capabilities.items.find(c => c.id === 'session.plan_review')?.supported).toBe(true)
    await session.configure({ optionId: 'permission', value: 'ask_all' })
    expect(JSON.parse(readFileSync(layout.permissionFile, 'utf8'))[session.nativeSessionId]).toBe('ask_all')
    await session.planning.setMode('normal')
    expect(existsSync(join(layout.planningDir, sha(session.nativeSessionId)))).toBe(false)
    await handle.stop()
  })

  it('refuses a Pi whose approval guard did not load', async () => {
    const { handle, world, work } = setup()
    world.guardLoaded = false
    await expect(handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s', replay: 'none' })).rejects.toMatchObject({ error: { code: 'pi_permissions_unavailable' } })
    await handle.stop()
  })

  it('sends the AA message id, accepts on the guard start signal and uses stable native item ids', async () => {
    const { handle, world, work } = setup()
    let release!: () => void
    world.configure = agent => {
      agent.onPrompt = async params => {
        const sessionId = String(params.sessionId)
        agent.started(sessionId)
        await new Promise<void>(resolve => (release = resolve))
        agent.text(sessionId, 'hi', 'msg-1')
        await tick()
        return { stopReason: 'end_turn' }
      }
    }
    const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s2', replay: 'none' }) as PiRuntimeSession
    const events = collect(session)
    // 接纳不等模型输出：守卫报告回合开始就算
    const acceptance = await session.prompt({ text: 'hello' }, { deliveryId: 'd', clientMessageId: 'c1' })
    expect(acceptance).toMatchObject({ outcome: 'accepted', userItemId: acpFingerprint(['aa_s2', 'user_message_chunk', 'c1']) })
    release()
    await until(() => of(events, 'turn.ended').length > 0)
    const prompt = world.agents[0]!.received.find(r => r.method === 'session/prompt')!
    expect(prompt.params._meta).toEqual({ aa: { clientMessageId: 'c1' } })
    const delta = of(events, 'message.delta')[0]!
    expect(delta.itemId).toBe(acpFingerprint(['aa_s2', 'agent_message_chunk', 'msg-1']))
    expect(of(events, 'session.info')).toEqual([])
    await handle.stop()
  })

  it('turns guard forms into approvals and plan reviews', async () => {
    const { handle, world, work } = setup()
    const answers: unknown[] = []
    world.configure = agent => {
      agent.onPrompt = async params => {
        const sessionId = String(params.sessionId)
        agent.update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'write', kind: 'edit', status: 'pending' })
        answers.push(await agent.confirmTool(sessionId, { id: 'call-1', name: 'write', input: { path: 'a.txt' } }))
        answers.push(await agent.reviewPlan(sessionId, 'plan-call', '# Plan\n- step'))
        answers.push(await agent.reviewPlan(sessionId, 'plan-call-2', '# Plan 2'))
        return { stopReason: 'end_turn' }
      }
    }
    const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s3', replay: 'none' }) as PiRuntimeSession
    const events = collect(session)
    let reviews = 0
    void (async () => {
      for (;;) {
        await tick(5)
        for (const opened of of(events, 'interaction.opened')) {
          if ((opened as { handled?: boolean }).handled) continue
          ;(opened as { handled?: boolean }).handled = true
          if (opened.kind === 'approval') await session.respond(opened.interactionId, { kind: 'option', optionId: 'allow' })
          else if (opened.kind === 'plan_review') {
            reviews += 1
            await session.respond(opened.interactionId, reviews === 1 ? { kind: 'plan_review', action: 'revise', feedback: 'more tests' } : { kind: 'plan_review', action: 'approve' })
          }
        }
        if (of(events, 'turn.ended').length) return
      }
    })()
    await session.prompt({ text: 'go' }, { deliveryId: 'd', clientMessageId: 'c' })
    await until(() => of(events, 'turn.ended').length > 0)
    const opened = of(events, 'interaction.opened')
    expect(opened[0]).toMatchObject({ kind: 'approval', title: 'write', options: [{ id: 'allow', kind: 'allow_once' }, { id: 'deny', kind: 'reject_once' }] })
    expect(opened[0]!.itemId).toBe(of(events, 'tool.started')[0]!.itemId)
    expect(opened[1]).toMatchObject({ kind: 'plan_review', plan: { planId: 'plan:plan-call', markdown: '# Plan\n- step' } })
    expect(answers).toEqual([
      { action: 'accept', content: { confirmed: true } },
      { action: 'accept', content: { value: 'revise\nmore tests' } },
      { action: 'accept', content: { value: 'approve' } },
    ])
    await handle.stop()
  })

  it('ends a dismissed plan turn as cancelled, not failed', async () => {
    const { handle, world, work } = setup()
    world.configure = agent => {
      agent.onPrompt = async params => {
        const answer = await agent.reviewPlan(String(params.sessionId), 'p', '# Plan')
        if (answer.action === 'cancel') throw new JsonRpcError(-32603, 'Internal error: This operation was aborted')
        return { stopReason: 'end_turn' }
      }
    }
    const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s4', replay: 'none' }) as PiRuntimeSession
    const events = collect(session)
    void session.prompt({ text: 'plan it' }, { deliveryId: 'd', clientMessageId: 'c' })
    await until(() => of(events, 'interaction.opened').length > 0)
    await session.respond(of(events, 'interaction.opened')[0]!.interactionId, { kind: 'plan_review', action: 'dismiss' })
    await until(() => of(events, 'turn.ended').length > 0)
    expect(of(events, 'turn.ended')[0]).toMatchObject({ reason: 'cancelled' })
    await handle.stop()
  })

  it('authorizes /bash before dispatch and refuses it in read-only mode', async () => {
    const { handle, world, work } = setup()
    const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s5', replay: 'none' }) as PiRuntimeSession
    const events = collect(session)
    const pending = session.prompt({ text: '/bash rm -rf build' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    await until(() => of(events, 'interaction.opened').length > 0)
    expect(of(events, 'interaction.opened')[0]).toMatchObject({ kind: 'approval', title: 'bash', body: 'rm -rf build' })
    await session.respond(of(events, 'interaction.opened')[0]!.interactionId, { kind: 'option', optionId: 'deny' })
    expect(await pending).toMatchObject({ outcome: 'rejected', error: { code: 'permission_denied' } })
    await session.configure({ optionId: 'aa-permission', value: 'readonly' })
    expect(await session.prompt({ text: '/bash ls' }, { deliveryId: 'd2', clientMessageId: 'c2' })).toMatchObject({ outcome: 'rejected', error: { code: 'permission_denied' } })
    expect(world.agents[0]!.received.some(r => r.method === 'session/prompt')).toBe(false)
    await handle.stop()
  })

  it('recycles an idle process and resumes on the native file without a session.lost', async () => {
    const { handle, world, work } = setup({ idleMs: 60_000 })
    world.configure = agent => {
      agent.onPrompt = async params => {
        const sessionId = String(params.sessionId)
        agent.text(sessionId, 'ok', `m-${world.agents.length}`)
        agent.persist(sessionId, work, [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'x', aaClientMessageId: 'c1' } }])
        return { stopReason: 'end_turn' }
      }
    }
    const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s6', replay: 'none' }) as PiRuntimeSession
    const events = collect(session)
    await session.prompt({ text: 'one' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    await until(() => of(events, 'turn.ended').length === 1)
    expect(await session.checkIdle(Date.now())).toBe(false)
    expect(await session.checkIdle(Date.now() + 120_000)).toBe(true)
    expect(world.agents[0]!.received.some(r => r.method === 'session/close')).toBe(true)
    const native = session.nativeSessionId
    expect((await session.prompt({ text: 'two' }, { deliveryId: 'd2', clientMessageId: 'c2' })).outcome).toBe('accepted')
    await until(() => of(events, 'turn.ended').length === 2)
    expect(world.agents).toHaveLength(2)
    expect(world.environments[1]).toMatchObject({ AA_PI_SESSION_ID: native, AA_PI_SESSION_FILE: expect.stringContaining(`${native}.jsonl`) })
    expect(world.agents[1]!.received.find(r => r.method === 'session/resume')?.params).toMatchObject({ sessionId: native, cwd: work })
    expect(session.nativeSessionId).toBe(native)
    expect(events.some(e => e.type === 'session.lost' || e.type === 'history.reset')).toBe(false)
    await handle.stop()
  })

  it('replays history written by another writer while dormant, and refuses input after a concurrent write', async () => {
    const { handle, world, work } = setup()
    world.configure = agent => {
      agent.onPrompt = async params => {
        agent.persist(String(params.sessionId), work, [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'one', aaClientMessageId: 'c1' } }])
        return { stopReason: 'end_turn' }
      }
    }
    const session = await handle.open({ kind: 'new', spec: { cwd: work } }, { sessionId: 'aa_s7', replay: 'none' }) as PiRuntimeSession
    const events = collect(session)
    await session.prompt({ text: 'one' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    await until(() => of(events, 'turn.ended').length === 1)
    await session.checkIdle(Date.now() + 3600_000)
    // 终端里的 pi 续写了一条
    const file = world.agents[0]!.sessionFiles.get(session.nativeSessionId)!
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'message', id: 'cli1', parentId: 'u1', message: { role: 'user', content: 'from cli' } }) + '\n')
    world.configure = agent => {
      agent.onPrompt = async () => ({ stopReason: 'end_turn' })
    }
    // 醒来时同步完整历史（v2 历史 ID）；新进程还没报告写入状态（模拟 bridge 未就绪），这次输入被拒绝而不是盲写。
    world.bridgeReports = false
    const result = await session.prompt({ text: 'two' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    await tick()
    const resets = of(events, 'history.reset')
    expect(resets.map(r => r.phase)).toEqual(['begin', 'commit', 'begin', 'commit'])
    const replayed = events.filter(e => e.type === 'message.completed' && e.replay === true)
    expect(replayed.map(e => (e as { itemId: string }).itemId)).toContain(piHistoryItemId('aa_s7', { type: 'message', id: 'cli1' }, 1, 0))
    expect(result).toMatchObject({ outcome: 'rejected', error: { code: 'pi_source_conflict' } })
    await handle.stop()
  })

  it('accepts input on a pinned file once the bridge reports a matching write state', async () => {
    const { handle, world, work, sessionsDir, layout } = setup()
    const file = join(sessionsDir, 'cli-session.jsonl')
    writeHistory(file, 'cli-session', work, [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'from the terminal' } }])
    world.configure = agent => {
      agent.onPrompt = async () => ({ stopReason: 'end_turn' })
    }
    const page = await handle.listNativeSessions()
    const ref = page.sessions.find(s => s.nativeSessionId === 'cli-session')!
    expect(ref).toMatchObject({ title: 'from the terminal', cwd: work })
    const session = await handle.open({ kind: 'existing', ref }, { sessionId: 'aa_s8', replay: 'full' }) as PiRuntimeSession
    const events = collect(session)
    expect(world.environments[0]).toMatchObject({ AA_PI_SESSION_FILE: ref.locator, AA_PI_SESSION_ID: 'cli-session' })
    expect(world.environments[0]!.AA_PI_SOURCE_REVISION).toMatch(/^sha256:/)
    expect(world.environments[0]!.AA_PI_WRITE_STATE!.startsWith(layout.root)).toBe(true)
    await tick()
    expect(events[0]).toMatchObject({ type: 'message.completed', replay: true, text: 'from the terminal', itemId: piHistoryItemId('aa_s8', { id: 'u1' }, 0, 0) })
    expect((await session.prompt({ text: 'continue' }, { deliveryId: 'd', clientMessageId: 'c' })).outcome).toBe('accepted')
    // 同一个原生文件只能有一个 AA 写者
    await expect(handle.open({ kind: 'existing', ref }, { sessionId: 'aa_s9', replay: 'none' })).rejects.toMatchObject({ error: { code: 'pi_source_busy' } })
    await handle.stop()
  })

  it('reads native history without starting Pi, with v2 browse ids', async () => {
    const { handle, world, work, sessionsDir } = setup()
    const file = join(sessionsDir, 'h.jsonl')
    writeHistory(file, 'hist', work, [
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'q' } },
      { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'a' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }] } },
      { type: 'message', id: 'r1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'out' }] } },
    ])
    const before = readFileSync(file)
    const ref = (await handle.listNativeSessions()).sessions[0]!
    const page = await handle.readNativeHistory(ref, { limit: 2 })
    const platform = piNativeSessionId('pi', ref.locator!, 'hist')
    expect(page.items.map(i => i.type)).toEqual(['message.completed', 'tool.started', 'tool.updated'])
    expect(page.items[0]).toMatchObject({ role: 'assistant', text: 'a', itemId: piHistoryItemId(platform, { id: 'a1' }, 1, 1) })
    expect(page.items[1]).toMatchObject({ kind: 'command', status: 'done', input: { command: 'ls' } })
    expect(page.olderCursor).toBe('2')
    const older = await handle.readNativeHistory(ref, { limit: 2, cursor: page.olderCursor!, direction: 'older' })
    expect(older.items.map(i => (i as { role?: string }).role)).toEqual(['user', 'reasoning'])
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(world.agents).toHaveLength(0)
    await handle.stop()
  })
})

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
