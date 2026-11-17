// Slash command catalog per session: each time the Runtime reports commands.updated (ACP
// available_commands_update), the session layer emits it as a runtime.status fact through LiveEvents. This keeps
// the latest one per session for `catalogs.commands` in Runtime/catalogs.

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
 * The latest command catalog per session, fed by every live event (`observe`, before the attach hub filters by
 * mode). Only `runtime.status` with `status.event === 'commands.updated'` changes it.
 */
export class SessionCommandCatalog {
  private readonly catalogs = new Map<string, readonly SessionCommand[]>()

  public constructor(private readonly max = MAX_COMMAND_CATALOGS) {}

  public observe(method: string, payload: Record<string, unknown>): void {
    if (method !== 'runtime.status' || typeof payload.sessionId !== 'string') return
    const status = record(payload.status)
    if (status === null || status.event !== 'commands.updated') return
    const commands = commandsOf(record(status.fact)?.commands ?? status.commands)
    if (commands === null) return
    this.catalogs.delete(payload.sessionId)
    this.catalogs.set(payload.sessionId, commands)
    while (this.catalogs.size > this.max) this.catalogs.delete(this.catalogs.keys().next().value as string)
  }

  /** The session's commands; empty when the Runtime has not reported any (the session is not open here). */
  public get(sessionId: string): readonly SessionCommand[] {
    return this.catalogs.get(sessionId) ?? []
  }
}
