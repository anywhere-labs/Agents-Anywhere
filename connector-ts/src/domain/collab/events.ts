import type { SessionAddress } from './address.js'
import type { Trigger } from './signals.js'

/** Collaboration domain events (§6). Those marked crossing leave the device through the outbox. */
export type CollabEvent =
  | { readonly type: 'AgentGrantIssued'; readonly grantId: string; readonly supervisor: SessionAddress }
  | { readonly type: 'AgentGrantRevoked'; readonly grantId: string; readonly supervisor: SessionAddress }
  | { readonly type: 'SupervisionChanged'; readonly supervisionId: string; readonly state: 'active' | 'paused' | 'ended' }
  | { readonly type: 'SupervisorWoken'; readonly supervisionId: string; readonly reasons: readonly Trigger[] }
  | { readonly type: 'EscalatedToHuman'; readonly supervisor: SessionAddress; readonly question: string }
