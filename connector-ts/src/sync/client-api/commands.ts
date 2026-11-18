// ported from Agents-Anywhere v2 server/agent_server/infra/device_link.py @4c8012369 (command_views, command_text, _slash_result, _COMMAND_UI)
// ported from Agents-Anywhere v2 server/agent_server/api/sessions.py @4c8012369 (_unknown_command_result)

import type { NativeAppCommandView } from '../../application/ports/index.js'
import type { EventMethod, LiveEvent, LiveEventPayloads } from '../../application/ports/index.js'

/** One slash command as the Runtime reported it (`commands.updated`). */
export interface SessionCommand {
  readonly name: string
  readonly description?: string
  readonly inputHint?: string
}

/** Sessions whose catalog is kept; the oldest is forgotten first (a catalog comes back with the next update). */
export const MAX_COMMAND_CATALOGS = 256

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function commandsOf(value: unknown): SessionCommand[] | null {
  if (!Array.isArray(value)) return null
  const commands: SessionCommand[] = []
  for (const item of value) {
    const command = record(item)
    if (command === null || typeof command.name !== 'string' || command.name === '') continue
    commands.push({
      name: command.name,
      ...(typeof command.description === 'string' ? { description: command.description } : {}),
      ...(typeof command.inputHint === 'string' ? { inputHint: command.inputHint } : {}),
    })
  }
  return commands
}

/**
 * The latest slash command catalog per session, fed by every live event the device emits (`observe`, whatever the
 * E2EE mode). Only `runtime.status` with `status.event === 'commands.updated'` changes it.
 */
export class SessionCommandCatalog {
  private readonly catalogs = new Map<string, readonly SessionCommand[]>()

  public constructor(private readonly max = MAX_COMMAND_CATALOGS) {}

  public observe<M extends EventMethod>(method: M, payload: LiveEventPayloads[M]): void {
    const event = { method, payload } as LiveEvent
    if (event.method !== 'runtime.status') return
    const { sessionId } = event.payload
    const status: Record<string, unknown> = event.payload.status
    if (typeof sessionId !== 'string' || status.event !== 'commands.updated') return
    const commands = commandsOf(status.commands)
    if (commands === null) return
    this.catalogs.delete(sessionId)
    this.catalogs.set(sessionId, commands)
    while (this.catalogs.size > this.max) this.catalogs.delete(this.catalogs.keys().next().value as string)
  }

  /** The session's commands; empty when the Runtime has not reported any (the session is not open here). */
  public get(sessionId: string): readonly SessionCommand[] {
    return this.catalogs.get(sessionId) ?? []
  }
}

/** How a client offers a Runtime slash command: run it at once, multi-line arguments, only while idle. */
const COMMAND_UI = { kind: 'execute', acceptsMultiline: true, allowedStatuses: ['idle'] }

/** `GET runtime/commands`: the catalog as `RuntimeCommandView` items, filtered by `query` and cut at `limit`. */
export function commandViews(catalog: readonly SessionCommand[], query: string | null = null, limit = 50): Record<string, unknown>[] {
  const views: Record<string, unknown>[] = []
  const needle = query === null || query === '' ? null : query.toLowerCase()
  for (const item of catalog) {
    if (typeof item.name !== 'string' || item.name === '') continue
    const description = typeof item.description === 'string' ? item.description : null
    if (needle !== null && !`${item.name} ${description ?? ''}`.toLowerCase().includes(needle)) continue
    const hint = item.inputHint
    views.push({
      id: item.name,
      title: item.name,
      description,
      aliases: [],
      category: null,
      scope: 'session',
      enabled: true,
      disabledReason: null,
      acceptsArgs: true,
      argsSchema: { type: 'string', ...(typeof hint === 'string' && hint !== '' ? { description: hint } : {}) },
      metadata: { ui: { ...COMMAND_UI, allowedStatuses: [...COMMAND_UI.allowedStatuses] } },
    })
  }
  return views.slice(0, Math.max(0, limit))
}

/** A native app's actions run at once, take no arguments and are offered whatever the session's status. */
const APP_COMMAND_UI = { kind: 'execute', acceptsMultiline: false, allowedStatuses: ['idle', 'error', 'running', 'waiting', 'waiting_approval', 'blocked', 'unknown'] }

/** `GET runtime/commands` items for the session's native desktop app commands, filtered by `query`. */
export function appCommandViews(commands: readonly NativeAppCommandView[], query: string | null = null): Record<string, unknown>[] {
  const needle = query === null || query === '' ? null : query.toLowerCase()
  return commands
    .filter(item => needle === null || [item.id, item.title, item.description, ...item.aliases].join(' ').toLowerCase().includes(needle))
    .map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      aliases: [...item.aliases],
      category: null,
      scope: 'session',
      enabled: true,
      disabledReason: null,
      acceptsArgs: false,
      argsSchema: null,
      metadata: { ui: { ...APP_COMMAND_UI, allowedStatuses: [...APP_COMMAND_UI.allowedStatuses] } },
    }))
}

const RAW_COMMAND = /^\s*\/([^\s]+)([\s\S]*)$/u

/**
 * The message a slash command sends: `/<command> <args>`, or the user's own `raw` text (its quoting and line
 * breaks kept) when it names the same command; null when `raw` names another command.
 */
export function commandText(command: string, args: readonly string[], raw: string | null): string | null {
  if (raw === null) return `/${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`
  const match = RAW_COMMAND.exec(raw)
  if (match === null || match[1]!.toLowerCase() !== command.toLowerCase()) return null
  return `/${command}${match[2]}`
}

/** The body of `POST runtime/commands` (`SessionCommandResponse` without `serverTime`). */
export function slashResult(command: string, ok: boolean, code: string | null = null, message: string | null = null, result: Record<string, unknown> = {}): Record<string, unknown> {
  return { command, ok, code, message, result, session: null }
}

/** The answer when the device cannot tell whether a slash command ran. */
export function unknownCommandResult(command: string): Record<string, unknown> {
  return slashResult(command, false, 'command_outcome_unknown', 'Command outcome is unknown. Refresh session state before taking further action.', { executionState: 'unknown', retryable: false })
}
