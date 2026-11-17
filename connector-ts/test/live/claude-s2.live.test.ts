// S2 field test: claude-agent-acp covers the existing Claude experience (08-migration-and-rollout.md §1).
// Skipped by default. Run:
//   AA_LIVE_CLAUDE=1 AA_CLAUDE_ACP=/path/to/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js \
//   [AA_S2_AIR=1] [AA_S2_WAKEUP=1] [AA_S2_MODE=default] corepack yarn vitest run test/live/claude-s2.live.test.ts
// Uses the real Claude Code login (~/.claude), creates sessions in a temporary directory and spends a little model quota.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { AcpClient, asRecord, type JsonRecord } from '../../src/runtime/acp/client.js'
import { AgentProcess } from '../../src/runtime/supervisor/agent-process.js'

const live = process.env.AA_LIVE_CLAUDE === '1'
const adapter = process.env.AA_CLAUDE_ACP ?? ''
const air = process.env.AA_S2_AIR === '1'
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), air }
const reportPath = process.env.AA_S2_REPORT ?? join(tmpdir(), `aa-v3-s2-report${air ? '-air' : ''}.json`)
const workdir = join(tmpdir(), `aa-v3-s2-workspace${air ? '-air' : ''}`)

interface Tracked {
  updates: { at: number; update: JsonRecord }[]
  requests: { method: string; params: JsonRecord }[]
}

type Answer = (method: string, params: JsonRecord) => unknown

async function startAdapter(): Promise<{ proc: AgentProcess; client: AcpClient; info: Record<string, unknown> }> {
  // Do not leak the host's CLAUDE*/ANTHROPIC* variables (for example the Claude Code running this test) to the adapter: they make it switch to host-managed auth.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/.test(key) && key !== 'CLAUDECODE'))
  const proc = new AgentProcess({ command: process.execPath, args: [adapter], cwd: workdir, env })
  const client = new AcpClient(proc.peer)
  const capabilities: JsonRecord = { elicitation: { form: {} }, session: { configOptions: { boolean: {} } } }
  if (air) capabilities._meta = { jetbrains: { air: { asyncTasks: {}, sessionFailure: {}, goal: {}, planFile: {} } } }
  const info = await proc.withExit(client.initialize({ protocolVersion: 1, clientCapabilities: capabilities, timeoutMs: 120_000 }))
  return { proc, client, info: { agentInfo: info.agentInfo, meta: info.meta, agentCapabilities: info.agentCapabilities, authMethods: info.authMethods } }
}

function track(client: AcpClient, sessionId: string, answer: Answer): Tracked {
  const tracked: Tracked = { updates: [], requests: [] }
  client.attach(sessionId, {
    onUpdate: update => tracked.updates.push({ at: Date.now(), update }),
    onRequest: async (method, params) => {
      tracked.requests.push({ method, params })
      return answer(method, params)
    },
  })
  return tracked
}

const text = (tracked: Tracked, since = 0): string => tracked.updates
  .filter(entry => entry.at >= since && entry.update.sessionUpdate === 'agent_message_chunk')
  .map(entry => String(asRecord(entry.update.content).text ?? '')).join('')

const kinds = (tracked: Tracked, since = 0): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const entry of tracked.updates) {
    if (entry.at < since) continue
    const kind = String(entry.update.sessionUpdate)
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function optionIds(params: JsonRecord): { id: string; kind: string; name: string }[] {
  return (Array.isArray(params.options) ? params.options.map(asRecord) : []).map(o => ({ id: String(o.optionId), kind: String(o.kind), name: String(o.name) }))
}

const isExitPlan = (params: JsonRecord): boolean => {
  const toolCall = asRecord(params.toolCall)
  return JSON.stringify(toolCall).includes('ExitPlanMode') || typeof asRecord(toolCall.rawInput).plan === 'string'
}

function jsonlFor(sessionId: string): string | undefined {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return undefined
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

describe.skipIf(!live)(`S2: claude-agent-acp (${air ? 'AIR' : 'plain'} client)`, () => {
  mkdirSync(workdir, { recursive: true })
  let sessionId = ''

  afterAll(() => {
    report.finishedAt = new Date().toISOString()
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`S2 report: ${reportPath}`)
  })

  it('plan review: revise (reject + steer feedback), then approve and execute', async () => {
    const { proc, client, info } = await startAdapter()
    report.initialize = info
    try {
      const created = asRecord(await client.request('session/new', { cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }))
      sessionId = String(created.sessionId)
      report.configOptions = (Array.isArray(created.configOptions) ? created.configOptions.map(asRecord) : []).map(o => ({
        id: o.id, category: o.category, currentValue: o.currentValue,
        values: (Array.isArray(o.options) ? o.options.map(asRecord) : []).map(v => v.value ?? v.group),
      }))
      await client.request('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' }, { timeoutMs: 60_000 })
      const reviews: Record<string, unknown>[] = []
      const permissions: Record<string, unknown>[] = []
      let planRound = 0
      const tracked = track(client, sessionId, (method, params) => {
        if (method !== 'session/request_permission') return { action: 'cancel' }
        const options = optionIds(params)
        if (isExitPlan(params)) {
          planRound += 1
          const plan = String(asRecord(asRecord(params.toolCall).rawInput).plan ?? '')
          reviews.push({ round: planRound, options, planHash: createHash('sha256').update(plan).digest('hex').slice(0, 16), planPreview: plan.slice(0, 300) })
          if (planRound === 1) {
            const reject = options.find(o => o.kind.startsWith('reject'))
            setTimeout(() => {
              void client.request('_session/steering', {
                sessionId,
                prompt: [{ type: 'text', text: 'Revise the plan: the file must be named plan-revised.txt (not plan-test.txt). Present the revised plan with ExitPlanMode.' }],
                _meta: { steering: { idleBehavior: 'promptRequired' } },
              }, { timeoutMs: 60_000 }).then(r => reviews.push({ steer: r })).catch(error => reviews.push({ steerError: String(error) }))
            }, 200)
            return { outcome: { outcome: 'selected', optionId: reject?.id } }
          }
          const approve = options.find(o => o.name.startsWith('Yes, manually approve')) ?? options.find(o => o.kind === 'allow_once')
          return { outcome: { outcome: 'selected', optionId: approve?.id } }
        }
        permissions.push({ title: asRecord(params.toolCall).title, options })
        const allow = options.find(o => o.kind === 'allow_once') ?? options[0]
        return { outcome: { outcome: 'selected', optionId: allow?.id } }
      })
      const t0 = Date.now()
      const result = asRecord(await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'AA v3 S2 spike. Make a short 2-step plan to create a file named plan-test.txt in the current directory containing the single word HELLO. Present the plan for approval with ExitPlanMode.' }],
      }, { timeoutMs: 600_000 }))
      let second: JsonRecord | undefined
      if (planRound < 2) {
        second = asRecord(await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Present the revised plan (file plan-revised.txt) with ExitPlanMode.' }] }, { timeoutMs: 600_000 }))
      }
      report.planReview = {
        stopReason: result.stopReason, secondStopReason: second?.stopReason ?? null, ms: Date.now() - t0, reviews, permissions,
        revisedFile: existsSync(join(workdir, 'plan-revised.txt')), originalFile: existsSync(join(workdir, 'plan-test.txt')),
        updates: kinds(tracked),
        planUpdates: tracked.updates.filter(e => e.update.sessionUpdate === 'plan' || e.update.sessionUpdate === 'plan_update').map(e => JSON.stringify(e.update).slice(0, 300)),
        modeUpdates: tracked.updates.filter(e => e.update.sessionUpdate === 'current_mode_update').map(e => e.update.currentModeId),
      }
      expect(reviews.filter(r => 'round' in r).length).toBeGreaterThanOrEqual(1)
    } finally {
      await proc.stop()
    }
  }, 900_000)

  it('plan review: dismiss (do not execute)', async () => {
    const { proc, client } = await startAdapter()
    try {
      const created = asRecord(await client.request('session/new', { cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }))
      const id = String(created.sessionId)
      await client.request('session/set_config_option', { sessionId: id, configId: 'mode', value: 'plan' }, { timeoutMs: 60_000 })
      let seen = false
      track(client, id, (method, params) => {
        if (method === 'session/request_permission' && isExitPlan(params)) {
          seen = true
          setTimeout(() => client.notify('session/cancel', { sessionId: id }), 100)
        }
        return { outcome: { outcome: 'cancelled' } }
      })
      const result = asRecord(await client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'Make a 1-step plan to create dismiss-test.txt containing NO. Present it with ExitPlanMode.' }] }, { timeoutMs: 600_000 }))
      report.planDismiss = { exitPlanSeen: seen, stopReason: result.stopReason, fileCreated: existsSync(join(workdir, 'dismiss-test.txt')) }
    } finally {
      await proc.stop()
    }
  }, 900_000)

  it('browsing history (session/load) vs the JSONL; resume after restart keeps context', async () => {
    expect(sessionId).not.toBe('')
    const file = jsonlFor(sessionId)
    const before = file ? statSync(file).size : -1
    const reader = await startAdapter()
    try {
      const { updates } = await reader.client.capture(sessionId, () => reader.client.request('session/load', { sessionId, cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }))
      await reader.client.request('session/close', { sessionId }, { timeoutMs: 30_000 }).catch(() => undefined)
      await sleep(1000)
      const after = file ? statSync(file).size : -1
      report.readOnlyLoad = { file: file ?? null, before, after, appended: after - before, replayedUpdates: updates.length }
    } finally {
      await reader.proc.stop()
    }
    const resumed = await startAdapter()
    try {
      const tracked = track(resumed.client, sessionId, () => ({ outcome: { outcome: 'cancelled' } }))
      const r = await resumed.client.request('session/resume', { sessionId, cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }).then(() => 'ok').catch(error => String(error))
      const t0 = Date.now()
      const result = asRecord(await resumed.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Without using any tools: what file name did we finally decide on? Reply with just the file name.' }] }, { timeoutMs: 300_000 }))
      report.resumeAfterRestart = { resume: r, stopReason: result.stopReason, text: text(tracked, t0) }
    } finally {
      await resumed.proc.stop()
    }
  }, 600_000)

  it.skipIf(process.env.AA_S2_WAKEUP !== '1')('scheduled wakeup produces an autonomous turn', async () => {
    const { proc, client } = await startAdapter()
    try {
      const created = asRecord(await client.request('session/new', { cwd: workdir, mcpServers: [] }, { timeoutMs: 120_000 }))
      const id = String(created.sessionId)
      if (process.env.AA_S2_MODE) {
        await client.request('session/set_config_option', { sessionId: id, configId: 'mode', value: process.env.AA_S2_MODE }, { timeoutMs: 60_000 })
      }
      const tracked = track(client, id, (method, params) => {
        if (method === 'session/request_permission') {
          const allow = optionIds(params).find(o => o.kind === 'allow_once')
          return { outcome: { outcome: 'selected', optionId: allow?.id } }
        }
        return { action: 'cancel' }
      })
      const result = asRecord(await client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: process.env.AA_S2_WAKEUP_PROMPT ?? 'Use your ScheduleWakeup tool to wake yourself up in 60 seconds; when you wake up, reply with exactly WOKE-UP. Now end your turn.' }] }, { timeoutMs: 300_000 }))
      const ended = Date.now()
      await sleep(Number(process.env.AA_S2_WAKEUP_WAIT_MS ?? 120_000))
      report.wakeup = {
        stopReason: result.stopReason,
        tools: tracked.updates.filter(e => e.update.sessionUpdate === 'tool_call').map(e => e.update.title),
        afterTurnUpdates: kinds(tracked, ended),
        turnText: text(tracked).slice(0, 600),
        toolResults: tracked.updates.filter(e => e.update.sessionUpdate === 'tool_call_update' && e.update.status !== undefined).map(e => JSON.stringify(e.update.rawOutput ?? e.update.content ?? null).slice(0, 300)),
        afterTurnText: text(tracked, ended),
        afterTurnSample: tracked.updates.filter(e => e.at >= ended).slice(0, 8).map(e => JSON.stringify(e.update).slice(0, 250)),
      }
    } finally {
      await proc.stop()
    }
  }, 600_000)
})
