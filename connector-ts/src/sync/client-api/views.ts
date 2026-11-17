// ported from Agents-Anywhere v2 server/agent_server/api/connector_terminal.py @4c8012369 (_normalize_terminal_v2_view)
// ported from Agents-Anywhere v2 server/agent_server/services/terminal.py @4c8012369 (_label_for, terminal_connector_scope_id)
// ported from Agents-Anywhere v2 server/agent_server/infra/terminal_broker.py @4c8012369 (Terminal.view)
// ported from Agents-Anywhere v2 server/agent_server/api/sessions.py @4c8012369 (runtime_state_from_rpc_payload)
// ported from Agents-Anywhere v2 server/agent_server/services/session_run.py @4c8012369 (_runtime_state_from_selection_result)
// ported from Agents-Anywhere v2 server/agent_server/core/models.py @4c8012369 (NoticeIn, NoticeSource, NoticeAction, NoticeActionInput, SessionRuntimeState, TerminalView)
// ported from Agents-Anywhere v2 server/agent_server/core/protocol.py @4c8012369 (ProtocolCapability, ProtocolModelItem, ProtocolReasoningItem, ProtocolPermissionItem)
import type { Session } from '../../domain/conversation/index.js'

// Client views with every field the client contracts declare, defaults included: what the Server's response models
// produced for the same routes. Keys a model does not declare are dropped where the model drops them.

type Json = Record<string, unknown>

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ------------------------------------------------------------------------------------------------ runtime state

const SESSION_STATUSES: ReadonlySet<string> = new Set(['idle', 'waiting', 'pending', 'running', 'stopping', 'waiting_approval', 'error', 'blocked'])

/**
 * `SessionRuntimeState`: the device's runtime state wire with the fields clients read filled in. `status` outside
 * the client set (`unknown`: nothing heard from the Runtime yet) reads as `idle`; without reported selections the
 * ones just requested are shown.
 */
export function runtimeStateView(raw: Json | null, session: Session, now: string, fallbackSelections: Readonly<Record<string, unknown>> = {}): Json {
  const state = raw ?? {}
  const status = text(state.status)
  return {
    sessionId: session.sessionId,
    runtime: session.runtimeType,
    runtimeId: session.runtimeId,
    runtimeType: session.runtimeType,
    externalSessionId: text(state.externalSessionId) ?? session.externalSessionId,
    status: status !== null && SESSION_STATUSES.has(status) ? status : 'idle',
    selections: record(state.selections) ?? { ...fallbackSelections },
    statusReason: text(state.statusReason),
    error: record(state.error),
    metadata: record(state.metadata) ?? {},
    updatedSeq: int(state.updatedSeq, session.clock.headSeq),
    createdAt: text(state.createdAt) ?? now,
    updatedAt: text(state.updatedAt) ?? now,
  }
}

// -------------------------------------------------------------------------------------------------- capabilities

/** Capabilities a read-only session may still use. */
const READ_CAPABILITIES: ReadonlySet<string> = new Set(['session.execution_position.read', 'session.configuration.read'])

/** One `ProtocolCapability` with its defaults; `allowed` also needs the session taken over unless it only reads. */
export function capabilityView(item: Json, session: Pick<Session, 'takeover' | 'runtimeId'>): Json {
  const capabilityId = String(item.capabilityId ?? '')
  const supported = item.supported !== false
  return {
    ...item,
    capabilityId,
    version: text(item.version) ?? '1',
    scope: text(item.scope) ?? 'runtime',
    runtime: text(item.runtime),
    runtimeId: text(item.runtimeId) ?? session.runtimeId,
    sessionId: text(item.sessionId),
    supported,
    available: item.available === undefined ? supported : item.available === true,
    allowed: item.allowed !== false && (session.takeover || READ_CAPABILITIES.has(capabilityId)),
    unavailableReason: text(item.unavailableReason) ?? (supported ? null : 'runtime_capability_unsupported'),
    parameters: record(item.parameters) ?? {},
    metadata: record(item.metadata) ?? {},
  }
}

export function capabilitySetView(set: Json | null, session: Pick<Session, 'takeover' | 'runtimeId'>): Json {
  const items = Array.isArray(set?.capabilities) ? (set.capabilities as unknown[]) : []
  return {
    revision: int(set?.revision, 0),
    capabilities: items.map(record).filter((item): item is Json => item !== null).map(item => capabilityView(item, session)),
  }
}

// ------------------------------------------------------------------------------------------------------ notices

function noticeAction(raw: Json): Json {
  const input = record(raw.input) ?? {}
  return {
    actionId: String(raw.actionId ?? ''),
    label: String(raw.label ?? ''),
    style: text(raw.style) ?? 'secondary',
    input: { required: input.required === true, schema: record(input.schema), uiSchema: record(input.uiSchema) },
  }
}

/** `NoticeIn`: a notice as `GET runtime/notices` lists it. */
export function noticeView(raw: Json): Json {
  const source = record(raw.source) ?? {}
  const blocking = record(raw.blocking)
  return {
    noticeId: String(raw.noticeId ?? ''),
    type: text(raw.type) ?? 'interaction',
    sessionId: String(raw.sessionId ?? ''),
    source: {
      runtime: text(source.runtime),
      component: text(source.component),
      approvalId: text(source.approvalId),
      timelineItemId: text(source.timelineItemId),
      operationId: text(source.operationId),
    },
    title: String(raw.title ?? ''),
    message: text(raw.message),
    severity: text(raw.severity) ?? 'info',
    status: text(raw.status) ?? 'open',
    interactionType: text(raw.interactionType),
    blocking: blocking === null ? null : { scope: 'session', targetId: String(blocking.targetId ?? '') },
    responseRequired: raw.responseRequired === true,
    actions: (Array.isArray(raw.actions) ? raw.actions : []).map(record).filter((item): item is Json => item !== null).map(noticeAction),
    context: record(raw.context) ?? {},
    metadata: record(raw.metadata) ?? {},
    expiresAt: text(raw.expiresAt),
    revision: int(raw.revision, 1),
    createdAt: text(raw.createdAt),
    resolvedAt: text(raw.resolvedAt),
  }
}

// ----------------------------------------------------------------------------------------------------- catalogs

function reasoningItem(raw: Json): Json {
  return {
    ...raw,
    displayName: String(raw.displayName ?? raw.id ?? ''),
    id: String(raw.id ?? ''),
    fullModelId: text(raw.fullModelId),
    selectionId: String(raw.selectionId ?? raw.id ?? ''),
    description: text(raw.description),
    default: raw.default === true,
    metadata: record(raw.metadata) ?? {},
  }
}

function modelItem(raw: Json): Json {
  return {
    ...raw,
    displayName: String(raw.displayName ?? raw.id ?? ''),
    id: String(raw.id ?? ''),
    selectionId: text(raw.selectionId),
    description: text(raw.description),
    default: raw.default === true,
    reasoningItems: (Array.isArray(raw.reasoningItems) ? raw.reasoningItems : []).map(record).filter((item): item is Json => item !== null).map(reasoningItem),
    group: record(raw.group),
    metadata: record(raw.metadata) ?? {},
  }
}

function permissionItem(raw: Json): Json {
  return {
    ...raw,
    displayName: String(raw.displayName ?? raw.id ?? ''),
    id: String(raw.id ?? ''),
    selectionId: String(raw.selectionId ?? raw.id ?? ''),
    description: text(raw.description),
    default: raw.default === true,
    metadata: record(raw.metadata) ?? {},
  }
}

/** `ProtocolModelCatalog`; a Runtime without one (or a session not open here) gives an empty catalog. */
export function modelCatalogView(raw: unknown, runtime: string): Json {
  const catalog = record(raw)
  if (catalog === null) return { runtime, revision: 1, models: [] }
  const items = Array.isArray(catalog.models) ? catalog.models : []
  return { ...catalog, runtime: text(catalog.runtime) ?? runtime, revision: int(catalog.revision, 1), models: items.map(record).filter((item): item is Json => item !== null).map(modelItem) }
}

/** `ProtocolPermissionCatalog`; an empty one when there is none. */
export function permissionCatalogView(raw: unknown, runtime: string): Json {
  const catalog = record(raw)
  if (catalog === null) return { runtime, revision: 1, permissions: [] }
  const items = Array.isArray(catalog.permissions) ? catalog.permissions : []
  return { ...catalog, runtime: text(catalog.runtime) ?? runtime, revision: int(catalog.revision, 1), permissions: items.map(record).filter((item): item is Json => item !== null).map(permissionItem) }
}

// ---------------------------------------------------------------------------------------------------- terminals

/** The scope of the terminals a device's file browser opens (not tied to a session). */
export function browseScope(deviceId: string): string {
  return `browse_${deviceId}`
}

/** A new terminal's label: the requested one, else the shell's name, numbered after the first. */
export function terminalLabel(label: string | null | undefined, shell: string | null | undefined, existing: number): string {
  const wanted = typeof label === 'string' ? label.trim() : ''
  if (wanted !== '') return wanted
  const path = (shell ?? '').trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  const base = path === '' ? 'Shell' : path.slice(path.lastIndexOf('/') + 1)
  return existing === 0 ? base : `${base} ${existing + 1}`
}

export interface TerminalFacts {
  readonly sessionId: string
  readonly terminalId?: string
  readonly root?: string | null
  readonly cwd?: string | null
  readonly label?: string | null
  readonly cols?: number | null
  readonly rows?: number | null
}

/** A `terminals-v2` terminal: the device's view with the root it was opened under and the defaults clients expect. */
export function terminalV2View(raw: unknown, facts: TerminalFacts, now: string): Json {
  const item: Json = { ...(record(raw) ?? {}) }
  if (facts.terminalId !== undefined) item.terminalId ??= facts.terminalId
  item.sessionId ??= facts.sessionId
  if (facts.root !== undefined && facts.root !== null) item.root = facts.root
  else if (nonEmpty(item.root) === null) item.root = nonEmpty(item.cwd) ?? '.'
  if (facts.cwd !== undefined && facts.cwd !== null) item.cwd ??= facts.cwd
  else item.cwd ??= item.root
  item.label ??= facts.label ?? 'Shell'
  item.purpose ??= 'user'
  item.pid ??= null
  item.cols ??= facts.cols ?? 80
  item.rows ??= facts.rows ?? 24
  item.status ??= item.closed === true ? 'exited' : 'running'
  item.exitCode ??= null
  item.scrollbackBytes ??= 0
  item.scrollbackSeq ??= 0
  item.persistent ??= false
  item.createdAt ??= now
  return item
}

/** The v1 `TerminalView` (`connectors/{id}/terminals`, `sessions/{id}/terminals`): exactly its fields. */
export function terminalV1View(raw: unknown, facts: TerminalFacts & { readonly ephemeralGroupId?: string | null }, now: string): Json {
  const item = terminalV2View(raw, facts, now)
  return {
    terminalId: String(item.terminalId ?? ''),
    sessionId: String(item.sessionId ?? ''),
    label: String(item.label ?? 'Shell'),
    root: String(item.root ?? '.'),
    cwd: String(item.cwd ?? item.root ?? '.'),
    cols: int(item.cols, 80),
    rows: int(item.rows, 24),
    purpose: 'user',
    pid: typeof item.pid === 'number' ? item.pid : null,
    status: item.status === 'starting' || item.status === 'exited' ? item.status : 'running',
    exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
    scrollbackBytes: int(item.scrollbackBytes, 0),
    scrollbackSeq: int(item.scrollbackSeq, 0),
    ephemeralGroupId: facts.ephemeralGroupId ?? null,
    persistent: item.persistent === true,
    createdAt: String(item.createdAt ?? now),
  }
}

/** Where each terminal was opened (root, working directory, scope): the device's terminal records do not keep it. */
export class TerminalRoots {
  private readonly roots = new Map<string, { readonly scope: string; readonly root: string; readonly cwd: string; readonly ephemeralGroupId: string | null }>()

  public remember(terminalId: string, scope: string, root: string, cwd: string, ephemeralGroupId: string | null = null): void {
    this.roots.set(terminalId, { scope, root, cwd, ephemeralGroupId })
  }

  public get(terminalId: string): { readonly scope: string; readonly root: string; readonly cwd: string; readonly ephemeralGroupId: string | null } | null {
    return this.roots.get(terminalId) ?? null
  }

  public forget(terminalId: string): void {
    this.roots.delete(terminalId)
  }

  /** Forgets terminals of `scope` that are no longer listed. */
  public prune(scope: string, live: ReadonlySet<string>): void {
    for (const [terminalId, entry] of this.roots) if (entry.scope === scope && !live.has(terminalId)) this.roots.delete(terminalId)
  }
}

// ----------------------------------------------------------------------------------------------------- planning

const PLANNING_FIELDS: Readonly<Record<string, unknown>> = {
  sessionId: '',
  runtime: '',
  runtimeId: null,
  effectiveMode: 'unknown',
  requestedMode: null,
  freshness: 'unknown',
  revision: 0,
  epoch: '',
  draft: null,
  proposal: null,
  proposals: [],
  review: null,
  capabilities: { supported: false, actions: [], contentStreaming: 'final_only', reason: null },
  operation: null,
  execution: null,
  executionProgress: null,
}

/** `fields`' keys only, each the value's own or the default. */
function withFields(state: Json, fields: Readonly<Record<string, unknown>>): Json {
  const out: Json = {}
  for (const [key, fallback] of Object.entries(fields)) out[key] = state[key] === undefined ? structuredClone(fallback) : state[key]
  return out
}

/** `PlanningState` with every field and nothing else (the model forbids other keys). */
export function planningView(raw: unknown): Json | null {
  const state = record(raw)
  if (state === null) return null
  const out = withFields(state, PLANNING_FIELDS)
  out.capabilities = withFields(record(out.capabilities) ?? {}, PLANNING_FIELDS.capabilities as Json)
  return out
}

const GOAL_FIELDS: Readonly<Record<string, unknown>> = {
  sessionId: '',
  runtime: '',
  runtimeId: null,
  externalSessionId: null,
  revision: 0,
  bindingGeneration: 0,
  sourceEpoch: '',
  sourceRevision: 0,
  pendingOperationId: null,
  goal: null,
  lastOutcome: null,
  freshness: 'unknown',
  capabilities: { supported: false, actions: [], reason: null },
}

/** `GoalState` with every field and nothing else (the model forbids other keys). */
export function goalView(raw: unknown): Json | null {
  const state = record(raw)
  if (state === null) return null
  const out = withFields(state, GOAL_FIELDS)
  out.capabilities = withFields(record(out.capabilities) ?? {}, GOAL_FIELDS.capabilities as Json)
  return out
}
