// What each Runtime type is known to support before its Agent has run (docs/api/capabilities.md).
//
// A Runtime's live capabilities come from the Agent's `initialize` negotiation, so they are unknown until the Agent
// process first starts. Clients decide on runtime-level capabilities before that (new-session options, plan mode,
// attachments, model and permission pickers), so every type declares the capabilities it has regardless of the
// negotiation here, and the live set refines them once known (`withDeclaredCapabilities`).
//
// A declaration lists only capabilities the type's live set also reports, so once the Agent has run every declared
// item is replaced by its live value. Capabilities the negotiation decides on its own are declared only when the
// type is known to have them.

import type { JsonValue } from '../identity/index.js'

export interface DeclaredCapability {
  readonly id: string
  readonly supported: boolean
  readonly parameters?: { readonly [key: string]: JsonValue }
}

const on = (id: string, parameters?: { readonly [key: string]: JsonValue }): DeclaredCapability =>
  (parameters === undefined ? { id, supported: true } : { id, supported: true, parameters })
const off = (id: string): DeclaredCapability => ({ id, supported: false })

/** What every ACP Agent supports whatever it negotiates. */
const ACP_SESSION: readonly DeclaredCapability[] = [
  on('session.send_message'),
  on('session.interrupt'),
  on('session.interaction.approval'),
  on('session.interaction.form'),
  on('session.commands'),
  on('session.configuration.read'),
  on('session.configuration.update'),
]

/** Runtimes that open the Agent session when the new-session page picks a directory (runtime-workflows 1.2). */
const WORKSPACE_PREPARATION: readonly DeclaredCapability[] = [
  on('runtime.workspace.prepare', { workflowVersion: '1.2' }),
  on('runtime.session.async_create', { workflowVersion: '1.2' }),
]

const PLANNING: readonly DeclaredCapability[] = [
  on('session.planning', { preparedCreation: true }),
  on('session.plan_document'),
  on('session.plan_review'),
]

/** Native sessions listed and read back, and image attachments. */
const NATIVE_HISTORY: readonly DeclaredCapability[] = [on('session.list'), on('session.history.native')]
const IMAGES = on('runtime.attachment', { image: true })
/** Attachments an ACP Agent takes as its negotiation allows. */
const ATTACHMENTS = on('runtime.attachment')

const DECLARED: Readonly<Record<string, readonly DeclaredCapability[]>> = {
  codex: [
    ...ACP_SESSION,
    on('session.steer'),
    ...NATIVE_HISTORY,
    IMAGES,
    on('catalog.model'),
    on('catalog.permission'),
    ...PLANNING,
    ...WORKSPACE_PREPARATION,
    off('session.goal'),
  ],
  claude: [
    ...ACP_SESSION,
    off('session.steer'),
    ...NATIVE_HISTORY,
    IMAGES,
    on('catalog.model'),
    on('catalog.permission'),
    ...PLANNING,
    ...WORKSPACE_PREPARATION,
  ],
  pi: [
    ...ACP_SESSION.filter(item => item.id !== 'session.commands' && item.id !== 'session.interaction.form'),
    ...NATIVE_HISTORY,
    ATTACHMENTS,
    on('catalog.permission'),
    ...PLANNING,
    ...WORKSPACE_PREPARATION,
  ],
  hermes: [
    ...ACP_SESSION,
    on('session.steer'),
    ATTACHMENTS,
    on('catalog.permission'),
    ...WORKSPACE_PREPARATION,
  ],
  // Both DSH routes (the plugin and DSH's own ACP) have these; the rest depends on the route.
  dsh: [
    on('session.send_message'),
    on('session.interrupt'),
    on('session.interaction.approval'),
    on('session.configuration.read'),
    on('session.configuration.update'),
    on('catalog.model'),
    on('catalog.effort'),
  ],
}

/** Any other ACP Agent shipped with the Connector. */
const ACP_AGENT: readonly DeclaredCapability[] = [
  ...ACP_SESSION,
  off('session.steer'),
  ATTACHMENTS,
  ...WORKSPACE_PREPARATION,
]

/** The runtime-level capabilities a Runtime type declares before its Agent has run. */
export function declaredRuntimeCapabilities(runtimeType: string): readonly DeclaredCapability[] {
  return Object.hasOwn(DECLARED, runtimeType) ? DECLARED[runtimeType]! : ACP_AGENT
}

/**
 * The declared capabilities refined by the live ones: a live item replaces the declared item with the same id,
 * declared items the live set does not mention are kept, and live-only items follow.
 */
export function withDeclaredCapabilities<T extends { readonly id: string }>(declared: readonly T[], live: readonly T[]): T[] {
  const byId = new Map(live.map(item => [item.id, item]))
  const merged = declared.map(item => byId.get(item.id) ?? item)
  const declaredIds = new Set(declared.map(item => item.id))
  return [...merged, ...live.filter(item => !declaredIds.has(item.id))]
}
