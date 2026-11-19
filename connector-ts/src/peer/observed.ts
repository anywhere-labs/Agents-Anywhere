// Anti-corruption layer of agent collaboration: client API shapes (protocol 1.2 timeline items, session views) in
// the collaboration domain's terms, so the digest and the tools never depend on the wire format.
import type { ObservedItem, TargetSignal, TargetStatus } from '../domain/collab/index.js'
import type { TargetView } from '../application/ports/index.js'

type Json = Record<string, unknown>

const record = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const int = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback)

const STATUSES: ReadonlySet<string> = new Set(['idle', 'pending', 'running', 'waiting', 'waiting_approval', 'blocked', 'stopping', 'error', 'unknown'])

export function targetStatus(value: unknown): TargetStatus {
  return typeof value === 'string' && STATUSES.has(value) ? (value as TargetStatus) : 'unknown'
}

/** A session view (`GET sessions/{id}/meta`, a directory row) as the target's signal and facts. */
export function targetView(deviceId: string, raw: unknown, at: string): TargetView | null {
  const view = record(raw)
  const sessionId = text(view.id) ?? text(view.sessionId)
  if (sessionId === null) return null
  const origin = record(view.origin)
  const planState = view.planState === 'planning' || view.planState === 'awaiting_review' ? view.planState : 'none'
  const goalState = view.goalState === 'active' || view.goalState === 'paused' || view.goalState === 'completed' ? view.goalState : 'none'
  const signal: TargetSignal = {
    status: targetStatus(view.status),
    headSeq: int(view.updatedSeq ?? view.headSeq),
    resetSeq: int(view.resetSeq),
    latestTurnEndSeq: typeof view.latestTurnEndSeq === 'number' ? view.latestTurnEndSeq : null,
    planState,
    goalState,
    deviceOnline: view.connectorStatus !== 'offline',
    at,
  }
  return {
    address: { deviceId: text(view.connectorId) ?? deviceId, sessionId },
    signal,
    title: text(view.title),
    runtimeType: text(view.runtimeType) ?? text(view.runtime),
    runtimeId: text(view.runtimeId),
    cwd: text(view.cwd),
    createdBySessionId: origin.kind === 'agent' ? text(origin.bySessionId) : null,
    depth: origin.kind === 'agent' ? int(origin.depth, 1) : 0,
  }
}

/** One protocol 1.2 timeline item as the digest reads it; null for items it skips (thinking, markers). */
export function observedItem(raw: unknown): ObservedItem | null {
  const item = record(raw)
  const id = text(item.id)
  if (id === null) return null
  const seq = int(item.seq ?? item.updatedSeq ?? item.orderSeq)
  const content = record(item.content)
  const status = text(item.status) ?? undefined
  const type = text(item.type) ?? ''
  const role = text(item.role) ?? ''
  if (type === 'message') {
    if (content.isThinking === true) return null
    const author = record(content.author)
    const kind = role === 'user' ? 'user' : 'assistant'
    return {
      id,
      seq,
      kind,
      text: typeof content.text === 'string' ? content.text : '',
      ...(status !== undefined ? { status } : {}),
      ...(kind === 'user' && (author.kind === 'agent' || author.kind === 'supervision') ? { author: author.kind } : {}),
    }
  }
  if (type === 'tool') {
    const files = filesOf(content)
    const input = record(content.input)
    const output = record(content.output)
    const command = text(input.command) ?? text(input.cmd) ?? text(content.command)
    const exit = output.exitCode ?? output.exit_code ?? content.exitCode
    const blocks = Array.isArray(content.content) ? content.content : []
    const resultText = [content.output, output.output, output.stdout, content.terminalOutput, content.text, ...blocks.map(block => {
      const value = record(block)
      return value.text ?? record(value.content).text
    })].filter(value => typeof value === 'string').join('\n')
    const marker = /(?:^|\n)AA_CHECK_EXIT:(-?\d+)(?=\s|$)/u.exec(resultText)
    const sha = /(?:^|\n)AA_CHECK_SHA:([a-f0-9]{40}|[a-f0-9]{64})(?=\s|$)/u.exec(resultText)?.[1] ?? null
    const exitCode = typeof exit === 'number' && Number.isInteger(exit) ? exit : marker === null ? null : Number(marker[1])
    return {
      id,
      seq,
      kind: files.length > 0 ? 'diff' : 'tool',
      title: text(content.title) ?? text(content.command) ?? 'tool',
      ...(status !== undefined ? { status } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(command !== null && exitCode !== null && Number.isSafeInteger(exitCode) ? { execution: { command: shellCommand(command), exitCode, sha } } : {}),
    }
  }
  if (type === 'plan') return { id, seq, kind: 'plan', title: text(content.title) ?? 'Plan', ...(status !== undefined ? { status } : {}) }
  if (type === 'system') return { id, seq, kind: 'system', text: text(content.text) ?? text(content.question) ?? '', ...(status !== undefined ? { status } : {}) }
  return null
}

/** Codex records the Runner's argv as a shell-quoted display string. Decode just its -c argument. */
function shellCommand(display: string): string {
  const argument = /^(?:[^\s]+\/)?(?:bash|dash|sh|zsh)\s+-(?:l?c|cl)\s+(.+)$/su.exec(display)?.[1]
  if (argument === undefined) return display
  let decoded = ''
  let offset = 0
  const segment = /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)|([^\s'"\\]+)/gsu
  for (const match of argument.matchAll(segment)) {
    if (match.index !== offset) return display
    decoded += match[1] ?? match[2]?.replace(/\\(["\\$`])/gu, '$1') ?? match[3] ?? match[4]
    offset += match[0].length
  }
  return offset === argument.length ? decoded : display
}

function filesOf(content: Json): { path: string; added?: number; removed?: number }[] {
  const raw = Array.isArray(content.files) ? content.files : Array.isArray(content.changes) ? content.changes : []
  const out: { path: string; added?: number; removed?: number }[] = []
  for (const entry of raw) {
    const file = record(entry)
    const path = text(file.path) ?? text(file.file)
    if (path === null) continue
    out.push({ path, ...(typeof file.added === 'number' ? { added: file.added } : {}), ...(typeof file.removed === 'number' ? { removed: file.removed } : {}) })
  }
  if (out.length === 0) {
    for (const location of Array.isArray(content.locations) ? content.locations : []) {
      const path = text(record(location).path)
      if (path !== null && content.kind === 'file_change') out.push({ path })
    }
  }
  return out
}
