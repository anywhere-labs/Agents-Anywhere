import { AgentDevice, AgentSession, SessionStatus } from '../../model/AgentSession';
import { runtimeInstanceLabels, RuntimeInstanceLabels } from '../../model/RuntimeIdentity';
import { RemoteSession } from '../../api/SessionsDtos';

/**
 * Wire-to-model mapping and list ordering.
 *
 * Port of `feature/sessions/SessionMappers.kt` and `SessionListIndicator.kt`.
 *
 * The display strings here are not localized on Android — `statusLabel`,
 * `summary` and the relative time are all computed in code rather than read from
 * resources — so they are reproduced as literals to keep the two clients
 * identical.
 */

const UNTITLED_SESSION: string = 'Untitled session';

/** Maps a wire session onto the app model using the device list for names. */
export function toAgentSession(
  dto: RemoteSession,
  devicesById: Map<string, AgentDevice>,
): AgentSession {
  const workspace: string = workspaceName(dto.cwd);
  const status: SessionStatus = toSessionStatus(dto.status);
  const externalId: string | null = nonBlank(dto.externalSessionId);
  const displayTitle: string = nonBlank(dto.title) ?? externalId ?? UNTITLED_SESSION;
  const activityAt: string | null = dto.sortAt ?? dto.lastActivityAt ?? dto.lastItemAt
    ?? dto.lastSyncedAt ?? dto.sourceObservedAt;
  const labels: RuntimeInstanceLabels = runtimeInstanceLabels(dto.runtimeName, dto.runtimeType);
  const device: AgentDevice | undefined = devicesById.get(dto.connectorId);
  const deviceName: string = device !== undefined
    ? device.name
    : (dto.connectorId.length > 8 ? dto.connectorId.substring(0, 8) : dto.connectorId) || 'Device';

  const metaParts: string[] = [labels.primary];
  if (labels.secondary !== null && labels.secondary.length > 0) {
    metaParts.push(labels.secondary);
  }
  if (deviceName.length > 0) {
    metaParts.push(deviceName);
  }
  if (workspace.length > 0) {
    metaParts.push(workspace);
  }

  return {
    id: dto.id,
    connectorId: dto.connectorId,
    projectId: dto.projectId,
    deviceName: deviceName,
    title: displayTitle,
    summary: summaryText(status, dto.cwd, dto.connectorStatus),
    cwd: dto.cwd,
    workspaceLabel: workspace,
    runtime: dto.runtimeType,
    runtimeLabel: labels.primary,
    status: status,
    statusLabel: statusLabel(status),
    updatedAtLabel: relativeTimeLabel(activityAt),
    metaLabel: metaParts.join('  ·  '),
    pinned: dto.pinned,
    archived: dto.archived,
    unread: dto.unread,
    lastReadSeq: dto.lastReadSeq,
    takeover: dto.takeover,
    connectorOnline: dto.connectorStatus === 'online',
    live: status === SessionStatus.Waiting || status === SessionStatus.Pending
      || status === SessionStatus.Running || status === SessionStatus.WaitingApproval,
    sortKey: dto.sortAt ?? dto.lastActivityAt ?? dto.lastItemAt ?? '',
    updatedSeq: dto.updatedSeq,
    runtimeId: dto.runtimeId,
    runtimeType: dto.runtimeType,
    runtimeName: dto.runtimeName,
    archivedAt: dto.archivedAt,
    optimisticTopUntil: 0,
    sortAt: dto.sortAt,
  };
}

/** One-line session summary shown in list rows on other clients. */
export function summaryText(status: SessionStatus, cwd: string | null, connectorStatus: string): string {
  if (status === SessionStatus.WaitingApproval) {
    return 'Waiting for approval.';
  }
  if (status === SessionStatus.Waiting || status === SessionStatus.Pending
    || status === SessionStatus.Running) {
    return 'Running now.';
  }
  if (status === SessionStatus.Error) {
    return 'Needs attention.';
  }
  if (cwd !== null && cwd.trim().length > 0) {
    return cwd;
  }
  if (connectorStatus === 'offline') {
    return 'Device is offline.';
  }
  return 'Ready for the next update.';
}

export function toSessionStatus(status: string): SessionStatus {
  if (status === 'idle') {
    return SessionStatus.Idle;
  }
  if (status === 'waiting') {
    return SessionStatus.Waiting;
  }
  if (status === 'pending') {
    return SessionStatus.Pending;
  }
  if (status === 'running') {
    return SessionStatus.Running;
  }
  if (status === 'stopping') {
    return SessionStatus.Stopping;
  }
  if (status === 'waiting_approval') {
    return SessionStatus.WaitingApproval;
  }
  if (status === 'error') {
    return SessionStatus.Error;
  }
  if (status === 'blocked') {
    return SessionStatus.Blocked;
  }
  return SessionStatus.Unknown;
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case SessionStatus.Idle:
      return 'Idle';
    case SessionStatus.Waiting:
      return 'Waiting';
    case SessionStatus.Pending:
      return 'Pending';
    case SessionStatus.Running:
      return 'Running';
    case SessionStatus.Stopping:
      return 'Stopping';
    case SessionStatus.WaitingApproval:
      return 'Approval';
    case SessionStatus.Error:
      return 'Error';
    case SessionStatus.Blocked:
      return 'Blocked';
    default:
      return 'Unknown';
  }
}

/** Last path segment of a working directory, used as the workspace label. */
export function workspaceName(cwd: string | null): string {
  if (cwd === null) {
    return '';
  }
  let trimmed: string = cwd.trim();
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  if (trimmed.length === 0) {
    return '';
  }
  const lastSlash: number = trimmed.lastIndexOf('/');
  const tail: string = lastSlash >= 0 ? trimmed.substring(lastSlash + 1) : '';
  return tail.length > 0 ? tail : trimmed;
}

/**
 * Compacts an ISO-8601 instant into the short relative label rows show.
 *
 * Android uses `Instant.parse`, which requires an explicit offset, so a value
 * without one yields an empty label rather than a guess. The same strictness is
 * kept here.
 */
export function relativeTimeLabel(instant: string | null): string {
  const millis: number | null = parseIsoInstantMillis(instant);
  if (millis === null) {
    return '';
  }
  const elapsedMillis: number = Math.max(0, Date.now() - millis);
  const minutes: number = Math.floor(elapsedMillis / 60_000);
  const hours: number = Math.floor(elapsedMillis / 3_600_000);
  const days: number = Math.floor(elapsedMillis / 86_400_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (hours < 24) {
    return `${hours}h`;
  }
  if (days === 1) {
    return 'Yest.';
  }
  if (days < 7) {
    return `${days}d`;
  }
  if (days < 365) {
    return `${Math.floor(days / 7)}w`;
  }
  return `${Math.floor(days / 365)}y`;
}

/** True when the text matches an ISO instant that carries a UTC offset. */
export function parseIsoInstantMillis(text: string | null): number | null {
  if (text === null || text.trim().length === 0) {
    return null;
  }
  const value: string = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const millis: number = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

/** Leading indicator a session row shows. */
export enum SessionListIndicator {
  None = 0,
  WaitingApproval = 1,
  Busy = 2,
  Unread = 3,
}

/**
 * Decides the row indicator.
 *
 * Order matters: an approval request outranks the spinner, and the unread dot
 * only appears on an otherwise idle session.
 */
export function sessionListIndicator(session: AgentSession): SessionListIndicator {
  if (session.status === SessionStatus.WaitingApproval) {
    return SessionListIndicator.WaitingApproval;
  }
  if (session.status === SessionStatus.Running
    || session.status === SessionStatus.Waiting
    || session.status === SessionStatus.Pending) {
    return SessionListIndicator.Busy;
  }
  if (session.status === SessionStatus.Idle && session.unread) {
    return SessionListIndicator.Unread;
  }
  return SessionListIndicator.None;
}

/**
 * Active-list ordering: pinned first, then running, then most recent activity.
 *
 * `optimisticTopUntil` floats a just-created or just-used session for a second
 * so it does not jump away while the Server snapshot is still catching up.
 */
export function compareSessions(left: AgentSession, right: AgentSession): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  const now: number = Date.now();
  const leftRunning: boolean = left.status === SessionStatus.Running || left.optimisticTopUntil > now;
  const rightRunning: boolean = right.status === SessionStatus.Running || right.optimisticTopUntil > now;
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  const bySortKey: number = compareStringsDescending(left.sortKey, right.sortKey);
  if (bySortKey !== 0) {
    return bySortKey;
  }
  return compareStringsDescending(left.id, right.id);
}

/** Archived-list ordering by archive time, falling back to activity. */
export function compareArchivedSessions(left: AgentSession, right: AgentSession): number {
  const leftKey: string = left.archivedAt ?? left.sortKey;
  const rightKey: string = right.archivedAt ?? right.sortKey;
  const byKey: number = compareStringsDescending(leftKey, rightKey);
  if (byKey !== 0) {
    return byKey;
  }
  return compareStringsDescending(left.id, right.id);
}

/** Rows truncate long titles to 15 characters plus an ellipsis. */
export function sessionDisplayTitle(title: string): string {
  return title.length > 15 ? `${title.substring(0, 15)}...` : title;
}

function compareStringsDescending(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left > right ? -1 : 1;
}

function nonBlank(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.trim().length > 0 ? value : null;
}
