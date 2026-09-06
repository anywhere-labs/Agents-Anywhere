import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { contentHash } from '../projection/identity.js'
import type { SessionVisibilityMetadata } from '../wire/protocol.js'

/** Derive the DSH navigation state that Agents Anywhere projects into Active or Archived. */
export function sessionVisibility(
  header: SessionHeader,
  events: readonly SessionEvent[],
  archivedSessionIds: ReadonlySet<SessionId>,
): SessionVisibilityMetadata {
  const localArchived = archivedSessionIds.has(header.id)
  const blank = !events.some(event => event.type === 'turn/start')
  const hiddenReasons: SessionVisibilityMetadata['hiddenReasons'] = []
  if (localArchived) hiddenReasons.push('archived')
  if (blank) hiddenReasons.push('blank')
  if (header.origin === 'subagent') hiddenReasons.push('subagent')
  return {
    hidden: hiddenReasons.length > 0,
    localArchived,
    blank,
    origin: header.origin ?? null,
    hiddenReasons,
  }
}

/** Build the opaque history marker from both the stored log and navigation visibility. */
export function sessionSyncRevision(
  persistenceRevision: SessionPersistenceRevision,
  visibility: SessionVisibilityMetadata,
): string {
  return contentHash({
    persistenceRevision: String(persistenceRevision),
    visibility: {
      hidden: visibility.hidden,
      localArchived: visibility.localArchived,
      blank: visibility.blank,
      origin: visibility.origin,
    },
  })
}
