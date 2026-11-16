import { sha256Hex } from './hash.js'

/**
 * planning/domain/session.py `stable_id`: prefix + sha256('\0'.join(parts))[:32].
 * plan_ (sessionId, nativeId), draft_ (sessionId, nativeId), review_ (planId, String(version)).
 */
export function planningStableId(prefix: string, ...parts: string[]): string {
  return `${prefix}${sha256Hex(parts.join('\0')).slice(0, 32)}`
}
