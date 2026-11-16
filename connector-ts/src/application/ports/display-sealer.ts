import type { DisplayFields } from '../../domain/conversation/index.js'

/**
 * The display envelope (02-domain-model.md §5.4): fields only people read (title, preview, working directory).
 * Plain in normal mode; sealed with the directory key in E2EE mode. The Server stores it and never reads it.
 */
export interface DisplayEnvelope {
  mode: 'plain' | 'sealed'
  keyId: string | null
  payload: Record<string, unknown> | string
}

/**
 * Seals display fields for the outbox at send time. The E2EE implementation lives with Device Trust (F); the
 * plain one is in sync/. A sealer that cannot seal (no directory key yet) must throw rather than fall back to
 * plain: in E2EE mode a plain envelope would leak.
 */
export interface DisplaySealer {
  seal(fields: DisplayFields): DisplayEnvelope
}
