import { runtimeInstanceLabels, RuntimeInstanceLabels } from './RuntimeIdentity';

/**
 * Shared app models.
 *
 * Port of `model/AgentSession.kt`. These are the stable concepts several
 * features read; the wire DTOs live in `api/` and are mapped into these by
 * `feature/sessions/SessionMappers.ets`.
 */

/** Session lifecycle as the client models it. */
export enum SessionStatus {
  Idle = 0,
  Waiting = 1,
  Pending = 2,
  Running = 3,
  Stopping = 4,
  WaitingApproval = 5,
  Error = 6,
  Blocked = 7,
  Unknown = 8,
}

export interface AgentSession {
  id: string;
  connectorId: string;
  projectId: string | null;
  deviceName: string;
  title: string;
  summary: string;
  cwd: string | null;
  workspaceLabel: string;
  /** Runtime type, kept for capability lookups. */
  runtime: string;
  runtimeLabel: string;
  status: SessionStatus;
  statusLabel: string;
  updatedAtLabel: string;
  metaLabel: string;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  lastReadSeq: number;
  takeover: boolean;
  connectorOnline: boolean;
  /** True while the runtime is actively working, used to float rows to the top. */
  live: boolean;
  sortKey: string;
  updatedSeq: number;
  runtimeId: string;
  runtimeType: string;
  runtimeName: string;
  archivedAt: string | null;
  /** Local ordering hint set right after an optimistic create or send. */
  optimisticTopUntil: number;
  /** Canonical timestamp including null, kept apart from the display fallback. */
  sortAt: string | null;
}

export function sessionRuntimeLabels(session: AgentSession): RuntimeInstanceLabels {
  return runtimeInstanceLabels(session.runtimeName, session.runtimeType);
}

export interface AgentDevice {
  id: string;
  name: string;
  deviceOs: string | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string | null;
}

/** Session counts the Server reports for a project's sidebar. */
export interface ProjectSessionCounts {
  active: number;
  archived: number;
}

export interface AgentProject {
  id: string;
  userId: string;
  connectorId: string;
  name: string;
  workspacePath: string;
  pinned: boolean;
  pinnedAt: string | null;
  activeSessionCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
  manuallyCreated: boolean;
  sidebarSessionCounts: ProjectSessionCounts | null;
}
