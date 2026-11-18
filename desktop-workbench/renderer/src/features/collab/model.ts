// Agent collaboration: pure parsing and view logic shared by the session page, the session list, the timeline and
// settings. Inputs are wire shapes (protocol 1.2 session views, timeline items, the device's `/collab` view and the
// Server's collaboration settings); every reader tolerates missing or malformed fields.

import type { SessionOrigin, SupervisionEdge } from "@/generated/protocol/v1_2/session-snapshot-response"

export type { SessionOrigin, SupervisionEdge }

export const COLLAB_TOOLS = [
  "aa_targets",
  "aa_spawn",
  "aa_send",
  "aa_steer",
  "aa_interrupt",
  "aa_status",
  "aa_read",
  "aa_wait",
  "aa_respond",
  "aa_plan_review",
  "aa_supervise",
  "aa_unsupervise",
  "aa_escalate",
  "aa_close",
] as const
export type CollabToolName = (typeof COLLAB_TOOLS)[number]

export const SUPERVISION_TRIGGERS = ["turn_end", "turn_failed", "notice_opened", "plan_proposed", "goal_changed", "stalled"] as const
export type SupervisionTrigger = (typeof SUPERVISION_TRIGGERS)[number]
export const DEFAULT_SUPERVISION_TRIGGERS: readonly SupervisionTrigger[] = ["turn_end", "turn_failed", "notice_opened", "plan_proposed", "stalled"]

export const AUTHORITY_KEYS = ["steer", "interrupt", "respondApproval", "reviewPlan", "close"] as const
export type AuthorityKey = (typeof AUTHORITY_KEYS)[number]
export type CollabAuthority = Record<AuthorityKey, boolean>
export const DEFAULT_AUTHORITY: Readonly<CollabAuthority> = Object.freeze({ steer: true, interrupt: false, respondApproval: false, reviewPlan: false, close: true })

export const AGENT_TOOLS_HOST_CAPABILITY = "runtime.agent_tools.host"

export type SupervisionState = SupervisionEdge["state"]

// ─── Session views ────────────────────────────────────────────

export type SessionCollabEdges = {
  origin: SessionOrigin | null
  supervisors: SupervisionEdge[]
  supervised: SupervisionEdge[]
}

type CollabSessionSource = { origin?: unknown; supervisors?: unknown; supervised?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

export function parseSessionOrigin(value: unknown): SessionOrigin | null {
  const raw = record(value)
  if (!raw || raw.kind !== "agent") return null
  const bySessionId = text(raw.bySessionId)
  if (!bySessionId) return null
  return {
    kind: "agent",
    bySessionId,
    byDeviceId: text(raw.byDeviceId),
    depth: typeof raw.depth === "number" && Number.isFinite(raw.depth) ? raw.depth : 1,
  }
}

const SUPERVISION_STATES: ReadonlySet<string> = new Set(["active", "paused", "ended"])

export function parseSupervisionEdge(value: unknown): SupervisionEdge | null {
  const raw = record(value)
  if (!raw) return null
  const supervisionId = text(raw.supervisionId)
  const supervisorSessionId = text(raw.supervisorSessionId)
  const targetSessionId = text(raw.targetSessionId)
  if (!supervisionId || !supervisorSessionId || !targetSessionId) return null
  const state = SUPERVISION_STATES.has(String(raw.state)) ? (raw.state as SupervisionState) : "active"
  return { supervisionId, supervisorSessionId, targetSessionId, state, createdBy: raw.createdBy === "agent" ? "agent" : "human" }
}

function parseEdges(value: unknown): SupervisionEdge[] {
  if (!Array.isArray(value)) return []
  return value.map(parseSupervisionEdge).filter((edge): edge is SupervisionEdge => edge !== null)
}

export function sessionCollabEdges(session: CollabSessionSource | null | undefined): SessionCollabEdges {
  return {
    origin: parseSessionOrigin(session?.origin),
    supervisors: parseEdges(session?.supervisors),
    supervised: parseEdges(session?.supervised),
  }
}

/** Edges that still matter to a person: active or paused. */
export function liveEdges(edges: readonly SupervisionEdge[]): SupervisionEdge[] {
  return edges.filter((edge) => edge.state !== "ended")
}

export type SessionCollabIndicator = { createdByAgent: boolean; supervised: boolean }

/** The small marks a session list row shows; `null` when there is nothing to show. */
export function sessionCollabIndicator(session: CollabSessionSource | null | undefined): SessionCollabIndicator | null {
  const edges = sessionCollabEdges(session)
  const createdByAgent = edges.origin !== null
  const supervised = liveEdges(edges.supervisors).length > 0
  return createdByAgent || supervised ? { createdByAgent, supervised } : null
}

export type TitledSession = { id: string; title?: string | null }

/** A session's title from the session list, or `null` when the session is unknown or untitled. */
export function sessionTitleOf(sessions: readonly TitledSession[], sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  const title = sessions.find((session) => session.id === sessionId)?.title?.trim()
  return title || null
}

/** Stands in for a session title in a translated sentence, so the title can be rendered as a link. */
export const SESSION_PLACEHOLDER = "\u2063session\u2063"

/** Splits a sentence around one placeholder; the placeholder becomes `null`. */
export function splitAroundPlaceholder(sentence: string, marker: string): Array<string | null> {
  const index = sentence.indexOf(marker)
  if (index < 0) return [sentence]
  const before = sentence.slice(0, index)
  const after = sentence.slice(index + marker.length)
  return [...(before ? [before] : []), null, ...(after ? [after] : [])]
}

/** A short form of a session id for places where the title is unknown. */
export function shortSessionId(sessionId: string): string {
  return sessionId.length > 10 ? `${sessionId.slice(0, 8)}…` : sessionId
}

// ─── Timeline items ───────────────────────────────────────────

type TimelineLike = { type?: string; role?: string | null; content?: Record<string, unknown> | null }

export type MessageAuthor = {
  kind: "agent" | "supervision"
  sessionId: string | null
  deviceId: string | null
  supervisionId: string | null
}

/** `content.author` of a user message a person did not type. */
export function messageAuthorOf(item: TimelineLike): MessageAuthor | null {
  if (item.type !== "message" || item.role !== "user") return null
  const raw = record(item.content?.author)
  if (!raw || (raw.kind !== "agent" && raw.kind !== "supervision")) return null
  return {
    kind: raw.kind,
    sessionId: text(raw.sessionId),
    deviceId: text(raw.deviceId),
    supervisionId: text(raw.supervisionId),
  }
}

export type CollabEscalation = {
  question: string
  context: string | null
  fromSessionId: string | null
  targetSessionId: string | null
}

/** A `system` item where an Agent handed a decision to the person. */
export function collabEscalationOf(item: TimelineLike): CollabEscalation | null {
  if (item.type !== "system" || item.content?.kind !== "collab_escalation") return null
  const content = item.content
  const question = text(content.question)
  if (!question) return null
  return {
    question,
    context: text(content.context),
    fromSessionId: text(content.fromSessionId),
    targetSessionId: text(content.targetSessionId),
  }
}

export type CollabToolCall = { tool: string; known: boolean; sessionId: string | null }

/** A tool item for one of the collaboration tools. */
export function collabToolOf(item: TimelineLike): CollabToolCall | null {
  if (item.type !== "tool") return null
  const raw = record(item.content?.collabTool)
  const tool = text(raw?.tool)
  if (!raw || !tool) return null
  return { tool, known: (COLLAB_TOOLS as readonly string[]).includes(tool), sessionId: text(raw.sessionId) }
}

export type DigestPreview = { preview: string; truncated: boolean }

/** The first lines of a supervision digest for its collapsed form. */
export function digestPreview(value: string, maxLines = 6, maxChars = 600): DigestPreview {
  const lines = value.replace(/\r\n/g, "\n").split("\n")
  let preview = lines.slice(0, maxLines).join("\n")
  let truncated = lines.length > maxLines
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars).trimEnd()
    truncated = true
  }
  return { preview: truncated ? `${preview.trimEnd()}\n…` : preview, truncated }
}

// ─── The device's `/collab` view ──────────────────────────────

export type CollabGrant = {
  grantId: string
  state: string
  depth: number
  crossDevice: boolean
  authority: CollabAuthority
  limits: { maxActiveChildren: number; maxDepth: number; wakesPerHour: number }
}

export type SupervisionDetail = {
  supervisionId: string
  targetSessionId: string
  targetDeviceId: string | null
  state: SupervisionState
  pausedReason: string | null
  triggers: SupervisionTrigger[]
  authority: CollabAuthority
  createdBy: "human" | "agent"
  createdAt: string | null
  updatedAt: string | null
  lastWakeAt: string | null
}

export type CollabAction = {
  actionId: string
  verb: string
  targetSessionId: string | null
  outcome: string | null
  errorCode: string | null
  at: string | null
}

export type CollabView = {
  sessionId: string
  available: boolean
  grant: CollabGrant | null
  supervisions: SupervisionDetail[]
  actions: CollabAction[]
}

export function parseAuthority(value: unknown, fallback: Readonly<CollabAuthority> = DEFAULT_AUTHORITY): CollabAuthority {
  const raw = record(value)
  return {
    steer: bool(raw?.steer, fallback.steer),
    interrupt: bool(raw?.interrupt, fallback.interrupt),
    respondApproval: bool(raw?.respondApproval, fallback.respondApproval),
    reviewPlan: bool(raw?.reviewPlan, fallback.reviewPlan),
    close: bool(raw?.close, fallback.close),
  }
}

export function parseTriggers(value: unknown): SupervisionTrigger[] {
  if (!Array.isArray(value)) return [...DEFAULT_SUPERVISION_TRIGGERS]
  const known = new Set<string>(SUPERVISION_TRIGGERS)
  return SUPERVISION_TRIGGERS.filter((trigger) => value.includes(trigger) && known.has(trigger))
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function parseGrant(value: unknown): CollabGrant | null {
  const raw = record(value)
  const grantId = text(raw?.grantId)
  if (!raw || !grantId) return null
  const limits = record(raw.limits)
  return {
    grantId,
    state: text(raw.state) ?? "active",
    depth: number(raw.depth, 0),
    crossDevice: bool(raw.crossDevice, false),
    authority: parseAuthority(raw.authority),
    limits: {
      maxActiveChildren: number(limits?.maxActiveChildren, 0),
      maxDepth: number(limits?.maxDepth, 0),
      wakesPerHour: number(limits?.wakesPerHour, 0),
    },
  }
}

export function parseSupervisionDetail(value: unknown): SupervisionDetail | null {
  const raw = record(value)
  const supervisionId = text(raw?.supervisionId)
  const targetSessionId = text(raw?.targetSessionId)
  if (!raw || !supervisionId || !targetSessionId) return null
  return {
    supervisionId,
    targetSessionId,
    targetDeviceId: text(raw.targetDeviceId),
    state: SUPERVISION_STATES.has(String(raw.state)) ? (raw.state as SupervisionState) : "active",
    pausedReason: text(raw.pausedReason),
    triggers: parseTriggers(raw.triggers),
    authority: parseAuthority(raw.authority),
    createdBy: raw.createdBy === "agent" ? "agent" : "human",
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
    lastWakeAt: text(raw.lastWakeAt),
  }
}

function parseAction(value: unknown): CollabAction | null {
  const raw = record(value)
  const actionId = text(raw?.actionId)
  if (!raw || !actionId) return null
  return {
    actionId,
    verb: text(raw.verb) ?? "unknown",
    targetSessionId: text(raw.targetSessionId),
    outcome: text(raw.outcome),
    errorCode: text(raw.errorCode),
    at: text(raw.at),
  }
}

function list<T>(items: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(items) ? items.map(parse).filter((item): item is T => item !== null) : []
}

export function parseCollabView(value: unknown, sessionId: string): CollabView {
  const raw = record(value)
  return {
    sessionId: text(raw?.sessionId) ?? sessionId,
    available: bool(raw?.available, false),
    grant: parseGrant(raw?.grant),
    supervisions: list(raw?.supervisions, parseSupervisionDetail),
    actions: list(raw?.actions, parseAction),
  }
}

/** The collaboration panel shows when the device offers collaboration or the session already has supervision edges. */
export function collabPanelVisible(collab: CollabView | null, edges: SessionCollabEdges): boolean {
  return Boolean(collab?.available) || (collab?.supervisions.length ?? 0) > 0 || edges.supervised.length > 0
}

export type SupervisedRow = {
  supervisionId: string
  targetSessionId: string
  state: SupervisionState
  createdBy: "human" | "agent"
  /** Present when the supervisor's device answered `/collab`; edges alone carry no triggers or authority. */
  detail: SupervisionDetail | null
}

/**
 * The sessions a supervisor watches: the device's detail first (newest state), then edges the session directory knows
 * but the device did not list. Ended supervisions go last.
 */
export function supervisedRows(edges: readonly SupervisionEdge[], collab: CollabView | null): SupervisedRow[] {
  const rows = new Map<string, SupervisedRow>()
  for (const detail of collab?.supervisions ?? []) {
    rows.set(detail.supervisionId, {
      supervisionId: detail.supervisionId,
      targetSessionId: detail.targetSessionId,
      state: detail.state,
      createdBy: detail.createdBy,
      detail,
    })
  }
  for (const edge of edges) {
    if (rows.has(edge.supervisionId)) continue
    rows.set(edge.supervisionId, { supervisionId: edge.supervisionId, targetSessionId: edge.targetSessionId, state: edge.state, createdBy: edge.createdBy, detail: null })
  }
  const rank = (state: SupervisionState) => (state === "ended" ? 1 : 0)
  return [...rows.values()].sort((a, b) => rank(a.state) - rank(b.state))
}

export type SupervisionTransition = "pause" | "resume" | "end"

export function supervisionTransitions(state: SupervisionState): SupervisionTransition[] {
  if (state === "active") return ["pause", "end"]
  if (state === "paused") return ["resume", "end"]
  return []
}

export function transitionTarget(transition: SupervisionTransition): SupervisionState {
  return transition === "pause" ? "paused" : transition === "resume" ? "active" : "ended"
}

type CandidateSession = TitledSession & { archived?: boolean }

/** Sessions a supervisor may start watching: not itself, not archived, not already watched. */
export function supervisionCandidates<T extends CandidateSession>(
  sessions: readonly T[],
  supervisorSessionId: string,
  rows: readonly SupervisedRow[],
): T[] {
  const watched = new Set(rows.filter((row) => row.state !== "ended").map((row) => row.targetSessionId))
  return sessions.filter((session) => session.id !== supervisorSessionId && !session.archived && !watched.has(session.id))
}

// ─── Server settings ──────────────────────────────────────────

export type CollabInstanceSettings = { enabled: boolean; crossDevice: boolean; authority: CollabAuthority }

export type CollabSettings = {
  enabled: boolean
  crossDevice: boolean
  instances: Record<string, CollabInstanceSettings>
}

export const DEFAULT_COLLAB_SETTINGS: Readonly<CollabSettings> = Object.freeze({ enabled: false, crossDevice: false, instances: {} })

export function defaultInstanceSettings(): CollabInstanceSettings {
  return { enabled: false, crossDevice: false, authority: { ...DEFAULT_AUTHORITY } }
}

export function parseCollabSettings(value: unknown): CollabSettings {
  const raw = record(value)
  const settings = record(raw?.settings) ?? raw
  const instances: Record<string, CollabInstanceSettings> = {}
  for (const [runtimeId, entry] of Object.entries(record(settings?.instances) ?? {})) {
    const item = record(entry)
    if (!item) continue
    instances[runtimeId] = {
      enabled: bool(item.enabled, false),
      crossDevice: bool(item.crossDevice, false),
      authority: parseAuthority(item.authority),
    }
  }
  return { enabled: bool(settings?.enabled, false), crossDevice: bool(settings?.crossDevice, false), instances }
}

export function instanceSettingsOf(settings: CollabSettings, runtimeId: string): CollabInstanceSettings {
  return settings.instances[runtimeId] ?? defaultInstanceSettings()
}

export function withInstanceSettings(
  settings: CollabSettings,
  runtimeId: string,
  patch: Partial<Omit<CollabInstanceSettings, "authority">> & { authority?: Partial<CollabAuthority> },
): CollabSettings {
  const current = instanceSettingsOf(settings, runtimeId)
  return {
    ...settings,
    instances: {
      ...settings.instances,
      [runtimeId]: {
        enabled: patch.enabled ?? current.enabled,
        crossDevice: patch.crossDevice ?? current.crossDevice,
        authority: { ...current.authority, ...(patch.authority ?? {}) },
      },
    },
  }
}

type CapabilityLike = { capabilityId: string; supported?: boolean; runtime?: string | null; runtimeId?: string | null }

/** Whether a runtime instance can host the collaboration tools (capability-driven, never by provider name). */
export function hostsAgentTools(capabilitySet: { capabilities?: readonly CapabilityLike[] } | null | undefined, runtimeId?: string | null): boolean {
  const matches = (capabilitySet?.capabilities ?? []).filter((capability) => capability.capabilityId === AGENT_TOOLS_HOST_CAPABILITY)
  const match = (runtimeId ? matches.find((capability) => capability.runtimeId === runtimeId) : undefined)
    ?? matches.find((capability) => !capability.runtimeId)
    ?? matches[0]
  return Boolean(match?.supported)
}
