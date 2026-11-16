// S1 实测：codex-acp 在真实 Codex App 上的双向同步（08-migration-and-rollout.md §1）。
// 默认跳过。运行：
//   AA_LIVE_CODEX=1 AA_CODEX_ACP=/path/to/codex-acp/dist/index.js \
//   [AA_CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex] \
//   corepack yarn vitest run test/live/codex-s1.live.test.ts
// 会在真实 ~/.codex 里新建线程（工作目录在临时目录），并用少量模型额度。

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AcpClient, asRecord, type JsonRecord } from '../../src/runtime/acp/client.js'
import { AgentProcess } from '../../src/runtime/supervisor/agent-process.js'

const live = process.env.AA_LIVE_CODEX === '1'
const adapter = process.env.AA_CODEX_ACP ?? ''
const codexPath = process.env.AA_CODEX_PATH ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
const report: Record<string, unknown> = { startedAt: new Date().toISOString() }
const reportPath = process.env.AA_S1_REPORT ?? join(tmpdir(), 'aa-v3-s1-report.json')
const workdir = join(tmpdir(), 'aa-v3-s1-workspace')

interface Session {
  updates: JsonRecord[]
  requests: { method: string; params: JsonRecord }[]
}

async function startAdapter(): Promise<{ proc: AgentProcess; client: AcpClient; init: Record<string, unknown> }> {
  const proc = new AgentProcess({
    command: process.execPath,
    args: [adapter],
    cwd: workdir,
    env: { ...process.env, CODEX_PATH: codexPath, NO_BROWSER: '1' },
  })
  const client = new AcpClient(proc.peer)
  const info = await proc.withExit(client.initialize({
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} }, session: { configOptions: { boolean: {} } } },
    meta: { codexIpc: { approvals: true, settings: true, historyReplacement: true } },
    timeoutMs: 60_000,
  }))
  return { proc, client, init: { agentInfo: info.agentInfo, protocolVersion: info.protocolVersion, codexIpc: asRecord(info.meta.codexIpc), steering: asRecord(info.meta.steering) } }
}

function track(client: AcpClient, sessionId: string, answer?: (method: string, params: JsonRecord) => unknown): Session {
  const session: Session = { updates: [], requests: [] }
  client.attach(sessionId, {
    onUpdate: update => session.updates.push(update),
    onRequest: async (method, params) => {
      session.requests.push({ method, params })
      if (answer) return answer(method, params)
      if (method === '_codex/session/history_reset') return { ready: true }
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      return { action: 'cancel' }
    },
  })
  return session
}

function agentText(session: Session): string {
  return session.updates
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => String(asRecord(update.content).text ?? ''))
    .join('')
}

const kinds = (session: Session): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const update of session.updates) {
    const kind = String(update.sessionUpdate)
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(!live)('S1: codex-acp × real Codex App (macOS)', () => {
  mkdirSync(workdir, { recursive: true })
  let createdThread = process.env.AA_S1_THREAD ?? ''
  const reuse = createdThread !== ''

  afterAll(() => {
    report.finishedAt = new Date().toISOString()
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`S1 report: ${reportPath}`)
  })

  it.skipIf(reuse)('initializes with codexIpc and lists App threads', async () => {
    const { proc, client, init } = await startAdapter()
    try {
      report.initialize = init
      expect(asRecord(init.codexIpc).owner).toBe(true)
      const listed = asRecord(await client.request('session/list', {}, { timeoutMs: 60_000 }))
      const sessions = Array.isArray(listed.sessions) ? listed.sessions.map(asRecord) : []
      report.list = { count: sessions.length, sample: sessions.slice(0, 3).map(s => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd })) }
      const owners = asRecord(await client.request('_codex/ipc/sessions', {}, { timeoutMs: 30_000 }))
      report.ipcOwnersAtStart = owners
      expect(sessions.length).toBeGreaterThan(0)
    } finally {
      await proc.stop()
    }
  }, 120_000)

  it.skipIf(reuse)('inspects and follows a thread the App holds, read-only', async () => {
    const { proc, client } = await startAdapter()
    try {
      const listed = asRecord(await client.request('session/list', {}, { timeoutMs: 60_000 }))
      const sessions = (Array.isArray(listed.sessions) ? listed.sessions.map(asRecord) : []).slice(0, 15)
      const inspections: Record<string, unknown>[] = []
      for (const s of sessions) {
        const inspect = asRecord(await client.request('_codex/session/inspect', { sessionId: s.sessionId }, { timeoutMs: 30_000 }).catch(error => ({ error: String(error) })))
        inspections.push({ sessionId: s.sessionId, ownership: inspect.ownership, execution: inspect.execution, control: inspect.control, route: inspect.route, writerLock: inspect.writerLock, error: inspect.error })
      }
      report.inspections = inspections
      const followable = inspections.find(i => i.route === 'follow')
      report.followCandidate = followable ?? null
      // 只读历史：不 resume
      const target = String((followable ?? inspections[0])?.sessionId ?? '')
      const read = asRecord(await client.request('_codex/session/read', { sessionId: target }, { timeoutMs: 60_000 }))
      report.readOnlyHistory = { sessionId: target, updates: Array.isArray(read.updates) ? read.updates.length : null }
      if (followable) {
        const sessionId = String(followable.sessionId)
        const session = track(client, sessionId)
        const t0 = Date.now()
        const loaded = asRecord(await client.request('session/load', { sessionId, cwd: workdir, mcpServers: [], _meta: { codexIpc: { mode: 'auto' } } }, { timeoutMs: 120_000 }))
        report.follow = {
          sessionId,
          ms: Date.now() - t0,
          route: asRecord(asRecord(loaded._meta).codexIpc),
          replayed: kinds(session),
          configOptions: Array.isArray(loaded.configOptions) ? loaded.configOptions.map(o => ({ id: asRecord(o).id, currentValue: asRecord(o).currentValue })) : null,
        }
        await client.request('session/close', { sessionId }, { timeoutMs: 30_000 }).catch(error => (report.followCloseError = String(error)))
      }
    } finally {
      await proc.stop()
    }
  }, 300_000)

  it.skipIf(reuse)('AA creates a thread that codex-acp owns and publishes', async () => {
    const { proc, client } = await startAdapter()
    try {
      const created = asRecord(await client.request('session/new', { cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }))
      createdThread = String(created.sessionId)
      const session = track(client, createdThread)
      const t0 = Date.now()
      const result = asRecord(await client.request('session/prompt', {
        sessionId: createdThread,
        prompt: [{ type: 'text', text: 'AA v3 S1 spike. Reply with exactly: S1-NEW-OK' }],
        _meta: { codexIpc: { clientMessageId: 'aa-s1-new-1' } },
      }, { timeoutMs: 300_000 }))
      const owners = asRecord(await client.request('_codex/ipc/sessions', {}, { timeoutMs: 30_000 }))
      const inspect = asRecord(await client.request('_codex/session/inspect', { sessionId: createdThread }, { timeoutMs: 30_000 }))
      report.created = {
        sessionId: createdThread,
        stopReason: result.stopReason,
        ms: Date.now() - t0,
        text: agentText(session),
        updates: kinds(session),
        configOptions: Array.isArray(created.configOptions) ? created.configOptions.map(o => ({ id: asRecord(o).id, category: asRecord(o).category, currentValue: asRecord(o).currentValue })) : null,
        inspect: { ownership: inspect.ownership, route: inspect.route, control: inspect.control },
        publishedInOwners: JSON.stringify(owners).includes(createdThread),
      }
      expect(agentText(session)).toContain('S1-NEW-OK')
      // 给 App 留时间看到发布（侧边栏需人工确认）
      await sleep(3000)
      try {
        execFileSync('screencapture', ['-x', join(tmpdir(), 'aa-v3-s1-owner.png')])
        report.ownerScreenshot = join(tmpdir(), 'aa-v3-s1-owner.png')
      } catch (error) {
        report.ownerScreenshot = `failed: ${String(error)}`
      }
    } finally {
      await proc.stop()
    }
  }, 400_000)

  it('hands the thread to the App by deeplink, then AA follows it and sends a message', async () => {
    expect(createdThread).not.toBe('')
    if (!reuse) {
      execFileSync('open', [`codex://threads/${createdThread}`])
      await sleep(8000)
    }
    const { proc, client } = await startAdapter()
    try {
      const before = asRecord(await client.request('_codex/session/inspect', { sessionId: createdThread }, { timeoutMs: 30_000 }))
      report.afterDeeplink = { ownership: before.ownership, route: before.route, control: before.control, writerLock: before.writerLock }
      if (before.route !== 'follow') return
      const session = track(client, createdThread)
      const loaded = asRecord(await client.request('session/load', { sessionId: createdThread, cwd: workdir, mcpServers: [], _meta: { codexIpc: { mode: 'auto' } } }, { timeoutMs: 120_000 }))
      const route = asRecord(asRecord(loaded._meta).codexIpc)
      session.updates.length = 0
      const t0 = Date.now()
      const result = asRecord(await client.request('session/prompt', {
        sessionId: createdThread,
        prompt: [{ type: 'text', text: 'Reply with exactly: S1-FOLLOW-OK' }],
        _meta: { codexIpc: { clientMessageId: 'aa-s1-follow-1' } },
      }, { timeoutMs: 300_000 }))
      const followText = agentText(session)
      // 设置切换：思考强度
      const options = Array.isArray(loaded.configOptions) ? loaded.configOptions.map(asRecord) : []
      const effort = options.find(o => o.category === 'thought_level' || o.id === 'reasoning_effort')
      let settings: unknown = 'no effort option'
      if (effort) {
        const values = (Array.isArray(effort.options) ? effort.options.map(asRecord) : []).map(o => String(o.value))
        const next = values.find(v => v !== effort.currentValue)
        if (next) {
          settings = await client.request('session/set_config_option', { sessionId: createdThread, configId: effort.id, value: next }, { timeoutMs: 60_000 })
            .then(r => ({ ok: true, to: next, options: (asRecord(r).configOptions as unknown[] | undefined)?.length }))
            .catch(error => ({ ok: false, error: String(error) }))
        }
      }
      report.followWrite = { route, stopReason: result.stopReason, ms: Date.now() - t0, text: followText, updates: kinds(session), settings, requests: session.requests.map(r => r.method) }
      try {
        execFileSync('screencapture', ['-x', join(tmpdir(), 'aa-v3-s1-follow.png')])
        report.followScreenshot = join(tmpdir(), 'aa-v3-s1-follow.png')
      } catch (error) {
        report.followScreenshot = `failed: ${String(error)}`
      }
      await client.request('session/close', { sessionId: createdThread }, { timeoutMs: 30_000 }).catch(() => undefined)
      expect(followText).toContain('S1-FOLLOW-OK')
    } finally {
      await proc.stop()
    }
  }, 500_000)

  it.skipIf(process.env.AA_S1_OWNER !== '1')('App follows a thread AA owns (deeplink while codex-acp holds it)', async () => {
    const { proc, client } = await startAdapter()
    try {
      const created = asRecord(await client.request('session/new', { cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }))
      const threadId = String(created.sessionId)
      const session = track(client, threadId)
      await client.request('session/prompt', { sessionId: threadId, prompt: [{ type: 'text', text: 'AA v3 S1 owner spike. Reply with exactly: S1-OWNER-1' }] }, { timeoutMs: 300_000 })
      const logMark = new Date().toISOString()
      execFileSync('open', [`codex://threads/${threadId}`])
      await sleep(10_000)
      const owners1 = asRecord(await client.request('_codex/ipc/sessions', {}, { timeoutMs: 30_000 }))
      session.updates.length = 0
      await client.request('session/prompt', { sessionId: threadId, prompt: [{ type: 'text', text: 'Reply with exactly: S1-OWNER-2' }] }, { timeoutMs: 300_000 })
      await sleep(5000)
      report.ownerDirection = { threadId, logMark, owners: owners1, secondTurnText: agentText(session) }
    } finally {
      await proc.stop()
    }
  }, 500_000)

  it.skipIf(process.env.AA_S1_FOLLOW_EXTRA !== '1')('followed thread: repeat loads, approval forwarded to AA, settings', async () => {
    const threadId = process.env.AA_S1_FOLLOW_THREAD ?? ''
    const results: unknown[] = []
    for (let round = 0; round < Number(process.env.AA_S1_ROUNDS ?? 3); round++) {
      const { proc, client } = await startAdapter()
      try {
        const approvals: JsonRecord[] = []
        const session = track(client, threadId, (method, params) => {
          if (method === 'session/request_permission') {
            approvals.push(params)
            const options = Array.isArray(params.options) ? params.options.map(asRecord) : []
            const allow = options.find(o => o.kind === 'allow_once') ?? options[0]
            return { outcome: { outcome: 'selected', optionId: allow?.optionId } }
          }
          return { action: 'cancel' }
        })
        const loaded = await client.request('session/load', { sessionId: threadId, cwd: workdir, mcpServers: [], _meta: { codexIpc: { mode: 'auto' } } }, { timeoutMs: 120_000 })
          .then(asRecord).catch(error => ({ error: String(error) }) as JsonRecord)
        const entry: Record<string, unknown> = { round, route: asRecord(asRecord(loaded._meta).codexIpc), error: loaded.error ?? null,
          configOptions: Array.isArray(loaded.configOptions) ? loaded.configOptions.map(o => ({ id: asRecord(o).id, category: asRecord(o).category, currentValue: asRecord(o).currentValue })) : null }
        if (round === 0 && !loaded.error && process.env.AA_S1_READONLY === '1') {
          entry.setReadOnly = await client.request('session/set_config_option', { sessionId: threadId, configId: 'mode', value: 'read-only' }, { timeoutMs: 60_000 })
            .then(() => 'ok').catch(error => String(error))
        }
        if (round === 0 && !loaded.error) {
          const marker = join(tmpdir(), `aa-s1-approval-${Date.now()}`)
          session.updates.length = 0
          const result = await client.request('session/prompt', { sessionId: threadId, prompt: [{ type: 'text', text: `Run this exact shell command and nothing else: touch ${marker} ; then reply DONE` }] }, { timeoutMs: 300_000 })
            .then(asRecord).catch(error => ({ error: String(error) }) as JsonRecord)
          let exists = false
          try { execFileSync('test', ['-e', marker]); exists = true } catch { exists = false }
          entry.approval = { stopReason: result.stopReason ?? result.error, approvals: approvals.map(a => ({ title: asRecord(a.toolCall).title, options: (Array.isArray(a.options) ? a.options.map(asRecord) : []).map(o => `${String(o.kind)}:${String(o.optionId)}`) })), fileCreated: exists, text: agentText(session), updates: kinds(session) }
        }
        if (round === 0 && process.env.AA_S1_READONLY === '1') {
          entry.restoreMode = await client.request('session/set_config_option', { sessionId: threadId, configId: 'mode', value: 'agent' }, { timeoutMs: 60_000 })
            .then(() => 'ok').catch(error => String(error))
        }
        if (round === 1 && !loaded.error) {
          const options = Array.isArray(loaded.configOptions) ? loaded.configOptions.map(asRecord) : []
          const target = options.find(o => o.id === 'reasoning_effort') ?? options.find(o => o.id === 'collaboration_mode') ?? options[0]
          if (target) {
            const values = (Array.isArray(target.options) ? target.options.map(asRecord) : []).map(o => String(o.value))
            const next = values.find(v => v !== target.currentValue)
            entry.settings = next === undefined ? 'no alternative value' : await client.request('session/set_config_option', { sessionId: threadId, configId: target.id, value: next }, { timeoutMs: 60_000 })
              .then(r => ({ ok: true, id: target.id, from: target.currentValue, to: next, after: (Array.isArray(asRecord(r).configOptions) ? (asRecord(r).configOptions as unknown[]).map(asRecord).find(o => o.id === target.id)?.currentValue : null) }))
              .catch(error => ({ ok: false, id: target.id, error: String(error) }))
            if (next !== undefined) await client.request('session/set_config_option', { sessionId: threadId, configId: target.id, value: target.currentValue }, { timeoutMs: 60_000 }).catch(() => undefined)
          }
        }
        results.push(entry)
        await client.request('session/close', { sessionId: threadId }, { timeoutMs: 30_000 }).catch(() => undefined)
      } finally {
        await proc.stop()
      }
    }
    report.followExtra = results
  }, 900_000)
})

void homedir
