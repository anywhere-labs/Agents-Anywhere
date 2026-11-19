// Small text helpers shared by the thread's parts.
import type { AgentKind, ToolPart } from '@protocol/timeline'

/** What people call an agent. Display only: nothing in the UI branches on it. */
export function agentLabel(agent: AgentKind): string {
  return ({ codex: 'Codex', claude: 'Claude Code', dsh: 'DSH' } as Record<string, string>)[agent] ?? agent
}

export const basename = (p: string) => p.split(/[\\/]/).pop() || p
export const extOf = (p: string) => (basename(p).split('.').slice(1).pop() ?? '').toLowerCase()

const LANG_BY_EXT: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  sh: 'bash',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
}
export const languageOf = (path: string) => LANG_BY_EXT[extOf(path)] ?? ''

export function formatTokens(v: number) {
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

export function clock(iso: string) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** ACP tool output (rawOutput, or the text content) as text. */
export function outputText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(outputText).filter(Boolean).join('\n')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['stdout', 'output', 'text', 'content', 'formatted_output', 'aggregated_output']) {
      if (typeof o[k] === 'string') return o[k] as string
    }
    if (Object.keys(o).length === 1 && 'exit_code' in o) return ''
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** An exit code, when the output says one. */
export function exitCodeOf(v: unknown): number | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    const c = o.exit_code ?? o.exitCode
    if (typeof c === 'number') return c
  }
  return undefined
}

type Input = { command?: unknown; path?: unknown; file_path?: unknown; pattern?: unknown; query?: unknown; url?: unknown; line?: unknown; offset?: unknown; limit?: unknown; cwd?: unknown }
const inputOf = (t: ToolPart) => (t.input ?? {}) as Input

export function commandOf(t: ToolPart): string | undefined {
  const c = inputOf(t).command
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.join(' ')
  return undefined
}

export function cwdOf(t: ToolPart): string | undefined {
  const c = inputOf(t).cwd
  return typeof c === 'string' ? c : undefined
}

export function fileOf(t: ToolPart): string | undefined {
  const i = inputOf(t)
  return t.diffs?.[0]?.path ?? t.locations?.[0]?.path ?? (typeof i.path === 'string' ? i.path : typeof i.file_path === 'string' ? i.file_path : undefined)
}

/** The first line a read covered, from its input or location. */
export function startLineOf(t: ToolPart): number | undefined {
  const i = inputOf(t)
  const n = typeof i.line === 'number' ? i.line : typeof i.offset === 'number' ? i.offset : t.locations?.find((l) => l.line)?.line
  return n && n > 0 ? n : undefined
}

/** "#L70-95" for a read. */
export function rangeOf(t: ToolPart): string {
  const i = inputOf(t)
  const from = startLineOf(t)
  if (!from) return ''
  return typeof i.limit === 'number' ? `#L${from}-${from + i.limit - 1}` : `#L${from}`
}

export function queryOf(t: ToolPart): string {
  const i = inputOf(t)
  if (typeof i.pattern === 'string') return i.pattern
  if (typeof i.query === 'string') return i.query
  if (typeof i.url === 'string') return i.url
  return commandOf(t) ?? t.title
}
