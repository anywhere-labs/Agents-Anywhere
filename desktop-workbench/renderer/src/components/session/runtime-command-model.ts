import type { RuntimeCommand, RuntimeStatusValue, SessionCommandResponse } from "@/features/dashboard/types"
import { isApiError } from "@/lib/api/errors"

export type SlashIntent = { command: string; suffix: string; raw: string; multiline: boolean }

export function parseSlashIntent(raw: string): SlashIntent | null {
  const match = /^\s*\/([^\s]*)([\s\S]*)$/.exec(raw)
  if (!match) return null
  return { command: (match[1] ?? "").toLowerCase(), suffix: match[2] ?? "", raw, multiline: /[\r\n]/.test(raw) }
}

export type CommandUi =
  | { kind: "execute"; argumentHint?: string; acceptsMultiline?: boolean; allowedStatuses?: string[] }
  | { kind: "selector"; target: "model" | "reasoning" | "permission" | "collaborationMode" }

export function commandUi(command: RuntimeCommand): CommandUi | null {
  // Older runtime catalogs predate metadata.ui. Keep their existing execute
  // behavior, without opting them in to multiline or busy-state execution.
  if (!Object.prototype.hasOwnProperty.call(command.metadata ?? {}, "ui")) return { kind: "execute" }
  const value = command.metadata?.ui
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const ui = value as Record<string, unknown>
  if (ui.kind === "selector" && ["model", "reasoning", "permission", "collaborationMode"].includes(String(ui.target))) {
    return { kind: "selector", target: ui.target as "model" | "reasoning" | "permission" | "collaborationMode" }
  }
  if (ui.kind === "execute") return {
    kind: "execute",
    argumentHint: typeof ui.argumentHint === "string" ? ui.argumentHint : undefined,
    acceptsMultiline: ui.acceptsMultiline === true,
    allowedStatuses: Array.isArray(ui.allowedStatuses) ? ui.allowedStatuses.filter((item): item is string => typeof item === "string") : undefined,
  }
  return null
}

/** A slash token that could name a command; paths such as "/Users/me" never do. */
export function commandLikeToken(intent: SlashIntent): boolean {
  return /^[a-z0-9][a-z0-9_:.-]*$/.test(intent.command) || intent.command === ""
}

export function commandMatchesQuery(command: RuntimeCommand, query: string): boolean {
  const normalized = query.toLowerCase()
  if (!normalized) return true
  return [command.id, command.title, ...command.aliases].some(value => value.toLowerCase().startsWith(normalized))
}

export type SlashMode =
  | { kind: "message" }
  | { kind: "command"; command: RuntimeCommand }
  | { kind: "pending" }

/**
 * Only drafts naming a catalog command run as commands. Other slash text is a
 * normal message, so pasted paths and prose keep working.
 */
export function slashMode(intent: SlashIntent | null, commands: RuntimeCommand[], catalog: { usable: boolean; loading: boolean; error: boolean }): SlashMode {
  if (!intent || !catalog.usable || !intent.command || !commandLikeToken(intent)) return { kind: "message" }
  const command = exactCommand(intent, commands)
  if (command) return { kind: "command", command }
  // Without a catalog a bare "/name" cannot be classified: hold it rather than
  // sending an intended command to the model. Text after the name is a message.
  if (!commands.length && (catalog.loading || catalog.error) && !intent.suffix.trim()) return { kind: "pending" }
  return { kind: "message" }
}

export type CommandBlock = "disabled" | "busy" | "readOnly" | "offline" | "unavailable"

export function commandBlock(command: RuntimeCommand, status: RuntimeStatusValue, state: { capability: boolean; writable: boolean; online: boolean }): CommandBlock | null {
  if (!command.enabled) return "disabled"
  if (!state.online) return "offline"
  if (!state.capability) return "unavailable"
  if (!state.writable) return "readOnly"
  return commandAllowed(command, status, true, true, true) ? null : "busy"
}

export function exactCommand(intent: SlashIntent, commands: RuntimeCommand[]): RuntimeCommand | null {
  return commands.find(item => item.id.toLowerCase() === intent.command || item.aliases.some(alias => alias.toLowerCase() === intent.command)) ?? null
}

export function commandRequest(intent: SlashIntent | null, command: RuntimeCommand): { command: string; args: string[]; raw: string } | null {
  if (!intent || (intent.multiline && !commandUiAllowsMultiline(command))) return null
  if (intent.suffix.trim() && !command.acceptsArgs) return null
  // The raw line is authoritative. String arguments are one free-form value, not
  // an array of words (the public API caps args at 32 entries).
  const args = !intent.suffix.trim() ? [] : command.argsSchema?.type === "string"
    ? [intent.suffix.replace(/^\s/, "")]
    : intent.suffix.trim().split(/\s+/)
  return { command: command.id, args, raw: intent.raw }
}

function commandUiAllowsMultiline(command: RuntimeCommand): boolean {
  const ui = commandUi(command)
  return ui?.kind === "execute" && ui.acceptsMultiline === true
}

export function commandAllowed(command: RuntimeCommand, status: RuntimeStatusValue, capability: boolean, writable: boolean, online: boolean): boolean {
  if (!capability || !writable || !online || !command.enabled) return false
  const ui = commandUi(command)
  if (!ui) return false
  if (ui.kind === "execute") return ui.allowedStatuses?.includes(status) ?? (status === "idle" || status === "error")
  return status === "idle" || status === "error"
}

export type CommandOutcome = { ok: boolean; state: "accepted" | "completed" | "unknown"; message: string | null; code: string | null; result: unknown }

export function commandResult(response: Pick<SessionCommandResponse, "ok" | "code" | "message" | "result">): CommandOutcome {
  const data = response.result && typeof response.result === "object" && !Array.isArray(response.result)
    ? response.result as Record<string, unknown> : {}
  const state = data.executionState === "accepted" || data.executionState === "completed" || data.executionState === "unknown"
    ? data.executionState : response.code === "command_outcome_unknown" ? "unknown" : response.ok ? "accepted" : "completed"
  const nativeText = typeof data.text === "string" ? data.text : null
  const message = response.ok ? nativeText ?? response.message : response.message ?? nativeText
  return { ok: response.ok === true && state !== "unknown", state, message: message ?? null, code: response.code ?? null, result: response.result }
}

export function commandTransportFailure(error: unknown, fallback: string): CommandOutcome {
  const known = isApiError(error) && error.status >= 400 && error.status < 500
  return {
    ok: false,
    state: known ? "completed" : "unknown",
    code: known ? error.code ?? "command_rejected" : "command_outcome_unknown",
    message: error instanceof Error ? error.message : fallback,
    result: null,
  }
}
