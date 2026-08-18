import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence';
import type { SessionVisibilityMetadata } from '../wire/protocol.js';
/** Derive the DSH navigation state that Agents Anywhere projects into Active or Archived. */
export declare function sessionVisibility(header: SessionHeader, events: readonly SessionEvent[], archivedSessionIds: ReadonlySet<SessionId>): SessionVisibilityMetadata;
/** Build the opaque history marker from both the stored log and navigation visibility. */
export declare function sessionSyncRevision(persistenceRevision: SessionPersistenceRevision, visibility: SessionVisibilityMetadata): string;
