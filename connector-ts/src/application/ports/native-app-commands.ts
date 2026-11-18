/**
 * What the client API asks of a session's native desktop app (the Runtime port's `nativeApp` and `ownerRelease`),
 * offered as slash commands next to the Runtime's own. Implemented by application/runtimes `NativeAppCommands`; the
 * client API (sync) calls it.
 */
export interface NativeAppCommandView {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly aliases: readonly string[]
}

/** The body parts of a `SessionCommandResponse` (`command`, `session` and `serverTime` are the route's). */
export interface NativeAppCommandResult {
  readonly ok: boolean
  readonly code: string | null
  readonly message: string | null
  readonly result: Record<string, unknown>
}

export interface NativeAppCommandsApi {
  /** The app's commands this session can use now; empty when its Runtime has no app or the app is not installed. */
  list(sessionId: string): Promise<readonly NativeAppCommandView[]>
  /** Runs one of them; null when `command` (an id or alias) is none of this session's app commands. */
  execute(sessionId: string, command: string, args: readonly string[], context: { readonly takeover: boolean }): Promise<NativeAppCommandResult | null>
}
