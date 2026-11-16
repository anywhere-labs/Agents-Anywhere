import type { RuntimeHandle } from './runtime-session.js'

/**
 * Where the session engine finds the running Runtime instance for a session (`runtimeId`). Implemented by the
 * Runtime layer's supervisor; it starts the instance lazily and returns null when it is not configured or
 * cannot start.
 */
export interface RuntimeHandles {
  handle(runtimeId: string): Promise<RuntimeHandle | null>
}
