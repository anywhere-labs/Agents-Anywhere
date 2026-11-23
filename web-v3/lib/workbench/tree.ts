// The workbench hierarchy (docs/v3/client-experience-proposal.md §1): device → agent → project (cwd) → conversation.
// A project is only a working directory: conversations of different agents in the same directory share it, and its
// name is the directory's last segment. Framework-free so the sidebar, ⌘K and the device page agree on one shape.

import type { SessionSummary } from "@/lib/types/v3"

export interface ProjectNode {
  /** `${deviceId}:${cwd}` */
  key: string
  cwd: string
  name: string
  sessions: SessionSummary[]
  updated_at: string
}

export interface AgentNode {
  agent: string
  projects: ProjectNode[]
  count: number
  updated_at: string
}

const KNOWN_AGENTS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  pi: "Pi",
  dsh: "DSH",
  opencode: "OpenCode",
  cursor: "Cursor",
  qwen: "Qwen Code",
}

/** How an agent id reads: the device's own runtime name when known, else a known label, else the id capitalised. */
export function agentLabel(agent: string, runtimes?: { id: string; name: string }[]): string {
  const fromDevice = runtimes?.find((r) => r.id === agent)?.name
  if (fromDevice) return fromDevice
  const known = KNOWN_AGENTS[agent.toLowerCase()]
  if (known) return known
  return agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : agent
}

/** The project name for a working directory: its last path segment ("~" for a home directory). */
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "")
  if (!trimmed || trimmed === "~") return "~"
  if (/^(\/Users|\/home)\/[^/]+$/.test(trimmed) || /^[A-Za-z]:\\Users\\[^\\]+$/.test(trimmed)) return "~"
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

/** A path with the home directory written as `~`. */
export function tildePath(path: string): string {
  return path.replace(/^(\/Users|\/home)\/[^/]+/, "~")
}

const newer = (a: string, b: string) => (a > b ? a : b)

/**
 * One device's conversations as agent → project → conversation, newest first at every level (by `updated_at`).
 * Callers drop a level when it has a single child (§2.1: "只有一个 Agent 或一个项目时省略那一级").
 */
export function buildDeviceTree(sessions: SessionSummary[]): AgentNode[] {
  const agents = new Map<string, Map<string, ProjectNode>>()
  for (const s of sessions) {
    let projects = agents.get(s.agent)
    if (!projects) agents.set(s.agent, (projects = new Map()))
    const key = `${s.device_id}:${s.cwd}`
    let project = projects.get(key)
    if (!project) {
      project = { key, cwd: s.cwd, name: projectName(s.cwd), sessions: [], updated_at: s.updated_at }
      projects.set(key, project)
    }
    project.sessions.push(s)
    project.updated_at = newer(project.updated_at, s.updated_at)
  }
  const out: AgentNode[] = []
  for (const [agent, projects] of agents) {
    const list = [...projects.values()]
    for (const p of list) p.sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    out.push({
      agent,
      projects: list,
      count: list.reduce((n, p) => n + p.sessions.length, 0),
      updated_at: list.reduce((t, p) => newer(t, p.updated_at), ""),
    })
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/** Every project of one device (all agents together), newest first: the directory picker's suggestions. */
export function deviceProjects(sessions: SessionSummary[], extra: string[] = []): { cwd: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const s of [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s.updated_at)
  }
  for (const cwd of extra) if (cwd && !seen.has(cwd)) seen.set(cwd, "")
  return [...seen.keys()].map((cwd) => ({ cwd, name: projectName(cwd) }))
}

export const sessionKey = (s: Pick<SessionSummary, "device_id" | "id">) => `${s.device_id}:${s.id}`

export const sessionHref = (deviceId: string, sessionId: string) =>
  `/sessions/${encodeURIComponent(deviceId)}/${encodeURIComponent(sessionId)}`

export const deviceHref = (deviceId: string, tab?: string) =>
  `/devices/${encodeURIComponent(deviceId)}${tab ? `?tab=${tab}` : ""}`

/** Case-insensitive match of every whitespace-separated word of `query` somewhere in `haystack`. */
export function matchesQuery(query: string, ...haystack: (string | undefined | null)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = haystack.filter(Boolean).join(" ").toLowerCase()
  return words.every((w) => text.includes(w))
}
