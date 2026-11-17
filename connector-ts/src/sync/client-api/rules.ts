// ported from Agents-Anywhere v2 server/agent_server/api/sessions.py @4c8012369 (merge_interaction_input, best_effort_runtime_notice_context, respond_interaction)
// ported from Agents-Anywhere v2 server/agent_server/services/session_run.py @4c8012369 (_session_source_error_detail, SESSION_SOURCE_ERROR_CODES, _validate_attachment_mime_types, _capability_metadata, _require_session_capability)
// ported from Agents-Anywhere v2 server/agent_server/core/planning/commands.py @4c8012369 (parse_plan_command)
// ported from Agents-Anywhere v2 server/agent_server/core/capabilities.py @4c8012369 (capability_is_usable)
import type { Session } from '../../domain/conversation/index.js'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * A notice answer's input: the notice's own `context` first, the user's input over it; `approvalSource` objects of
 * both are merged key by key instead of replaced.
 */
export function mergeInteractionInput(context: Readonly<Record<string, unknown>>, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...context, ...input }
  const fromNotice = record(context.approvalSource)
  const fromInput = record(input.approvalSource)
  if (fromNotice !== null && fromInput !== null) merged.approvalSource = { ...fromNotice, ...fromInput }
  return merged
}

/** Error codes a client gets when the answer names a notice that is gone (`200 {ok: false, error}`, not an HTTP error). */
export const NOTICE_GONE_CODES: ReadonlySet<string> = new Set(['not_found', 'notice_not_found', 'interaction_not_found', 'request_not_found', 'approval_not_found'])

/** Interaction kinds answered by choosing one of the offered actions; they only carry input when the user typed some. */
const OPTION_KINDS: ReadonlySet<string> = new Set(['approval', 'confirmation'])

/**
 * The `input` to answer a notice with, or null to answer with the action alone. Forms always get the merged input
 * (an empty form is still an accept); an approval or confirmation gets it only when the user sent input, so a plain
 * option choice stays an option choice.
 */
export function noticeAnswerInput(notice: Readonly<Record<string, unknown>> | null, userInput: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
  const merged = mergeInteractionInput(record(notice?.context) ?? {}, userInput ?? {})
  const kind = typeof notice?.interactionType === 'string' ? notice.interactionType : null
  if (userInput === null && kind !== null && OPTION_KINDS.has(kind)) return null
  return merged
}

/** Error codes of a session whose source is gone, by `sourceAvailability`; anything else archived is `session_archived`. */
const SOURCE_ERROR_CODES: Readonly<Record<string, string>> = {
  archived: 'session_archived',
  unavailable: 'session_unavailable',
  deleted: 'session_deleted',
  missing: 'session_missing',
}

/** Why a message to an archived session is refused (`{code, message}`); null when the session takes messages. */
export function sessionSourceError(session: Pick<Session, 'archived' | 'sourceAvailability'>): { code: string; message: string } | null {
  if (!session.archived) return null
  const availability = session.sourceAvailability
  const code = SOURCE_ERROR_CODES[availability]
  // Archived with its source still there: the user archived it in Agents Anywhere.
  if (code === undefined) return { code: 'session_archived', message: 'session is archived in Agents Anywhere' }
  return { code, message: `session is ${availability} in the local runtime` }
}

/** One item of a `ProtocolCapabilitySet`. */
export type CapabilityItem = Readonly<Record<string, unknown>>

export function findCapability(set: Readonly<Record<string, unknown>> | null, capabilityId: string): CapabilityItem | null {
  const items = Array.isArray(set?.capabilities) ? (set.capabilities as unknown[]) : []
  for (const item of items) {
    const capability = record(item)
    if (capability?.capabilityId === capabilityId) return capability
  }
  return null
}

/**
 * Whether a session capability can be used now: the Runtime supports it and it is available, nothing withholds it,
 * and the session is taken over (an action on a read-only session is never allowed).
 */
export function capabilityUsable(capability: CapabilityItem | null, takeover: boolean): boolean {
  return capability !== null && capability.supported === true && capability.available !== false && capability.allowed !== false && takeover
}

/** The capability's optional restrictions (`metadata`, else `parameters`, where device Runtimes publish them). */
function restrictions(capability: CapabilityItem): Record<string, unknown> {
  return record(capability.metadata) ?? record(capability.parameters) ?? {}
}

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u

/**
 * The first attachment media type the capability's `allowedMimeTypes` does not list (parameters after `;` and case
 * ignored); null when every type is allowed or the capability sets no restriction.
 */
export function unsupportedMediaType(capability: CapabilityItem, mediaTypes: readonly string[]): string | null {
  const meta = restrictions(capability)
  if (!('allowedMimeTypes' in meta)) return null
  const raw = meta.allowedMimeTypes
  const allowed = new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase()).filter(value => MEDIA_TYPE.test(value)) : [])
  for (const mediaType of mediaTypes) {
    const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase()
    if (!allowed.has(normalized)) return normalized
  }
  return null
}

/** `/plan`, `/plan off` and `/plan <task>` as the planning command they stand for; null for anything else. */
export function parsePlanCommand(text: string): Record<string, unknown> | null {
  const value = text.replace(/^\s+/u, '')
  if (!value.startsWith('/plan')) return null
  const suffix = value.slice(5)
  if (suffix !== '' && !/^\s/u.test(suffix)) return null
  const content = suffix.startsWith('\r\n') ? suffix.slice(2) : suffix.slice(1)
  const trimmed = suffix.trim()
  if (trimmed === 'off') return { command: 'exit_plan' }
  if (trimmed !== '') return { command: 'submit_task', content }
  return { command: 'enter_plan' }
}
