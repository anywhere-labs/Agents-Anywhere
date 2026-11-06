import { AgentDevice, AgentSession } from '../../model/AgentSession';
import { SessionsState } from '../sessions/SessionsState';

/**
 * Device detail state and runtime management state.
 *
 * Port of `feature/devices/DeviceDetailState.kt` and the list-management half of
 * `DeviceRuntimeState.kt`.
 *
 * Both are derived: the device's sessions come straight out of `SessionsState`,
 * which the dashboard channel keeps current, and the runtime inventory is the one
 * piece the screen fetches for itself.
 */

export interface DeviceDetailWorkspace {
  /** Working directory, or `null` when the sessions had none. */
  path: string | null;
  title: string;
  detail: string;
  sessionCount: number;
  sortKey: string;
}

export interface DeviceDetailState {
  device: AgentDevice | null;
  workspaces: DeviceDetailWorkspace[];
  activeSessions: AgentSession[];
  archivedSessions: AgentSession[];
}

/**
 * Android's `workspaceTitle`: the last path segment.
 *
 * The `clean === '/'` branch is unreachable in the original too — trimming the
 * trailing slashes already reduced `/` to an empty string — and is kept so the
 * two implementations stay line-for-line comparable. The empty title for the
 * filesystem root is therefore Android's behaviour, not a porting slip.
 */
export function workspaceTitle(path: string | null): string {
  if (path === null) {
    return '(none)';
  }
  const clean: string = path.replace(/[/\\]+$/, '');
  if (clean === '/') {
    return '/';
  }
  const normalized: string = clean.replace(/\\/g, '/');
  const slash: number = normalized.lastIndexOf('/');
  const tail: string = slash >= 0 ? normalized.substring(slash + 1) : normalized;
  return tail.length > 0 ? tail : clean;
}

function trimmedPath(cwd: string | null): string | null {
  if (cwd === null) {
    return null;
  }
  const trimmed: string = cwd.trim().replace(/[/\\]+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Android's `SessionsState.deviceDetailState`.
 *
 * An unknown id falls back to the first device, which is what makes the page
 * usable while the dashboard is still filling in.
 */
export function deviceDetailState(state: SessionsState, deviceId: string | null): DeviceDetailState {
  let device: AgentDevice | null = null;
  for (const candidate of state.devices) {
    if (candidate.id === deviceId) {
      device = candidate;
      break;
    }
  }
  if (device === null && state.devices.length > 0) {
    device = state.devices[0];
  }
  const deviceKey: string = device === null ? '' : device.id;

  const active: AgentSession[] = state.sessions.filter(
    (session: AgentSession) => session.connectorId === deviceKey,
  );
  const archived: AgentSession[] = state.archivedSessions.filter(
    (session: AgentSession) => session.connectorId === deviceKey,
  );

  // Workspaces group both lists, keyed on the trimmed working directory.
  const order: string[] = [];
  const grouped: Map<string, AgentSession[]> = new Map();
  const none: AgentSession[] = [];
  for (const session of active.concat(archived)) {
    const path: string | null = trimmedPath(session.cwd);
    if (path === null) {
      none.push(session);
      continue;
    }
    const existing: AgentSession[] | undefined = grouped.get(path);
    if (existing === undefined) {
      order.push(path);
      grouped.set(path, [session]);
    } else {
      existing.push(session);
    }
  }
  const workspaces: DeviceDetailWorkspace[] = [];
  if (none.length > 0) {
    workspaces.push({
      path: null,
      title: workspaceTitle(null),
      detail: 'No working directory',
      sessionCount: none.length,
      sortKey: maxSortKey(none),
    });
  }
  for (const path of order) {
    const sessions: AgentSession[] = grouped.get(path) ?? [];
    workspaces.push({
      path: path,
      title: workspaceTitle(path),
      detail: path,
      sessionCount: sessions.length,
      sortKey: maxSortKey(sessions),
    });
  }
  workspaces.sort((left: DeviceDetailWorkspace, right: DeviceDetailWorkspace) => {
    if (left.sortKey !== right.sortKey) {
      return left.sortKey < right.sortKey ? 1 : -1;
    }
    const leftTitle: string = left.title.toLowerCase();
    const rightTitle: string = right.title.toLowerCase();
    if (leftTitle === rightTitle) {
      return 0;
    }
    return leftTitle < rightTitle ? -1 : 1;
  });

  return {
    device: device,
    workspaces: workspaces,
    activeSessions: active,
    archivedSessions: archived,
  };
}

function maxSortKey(sessions: AgentSession[]): string {
  let max: string = '';
  for (const session of sessions) {
    if (session.sortKey > max) {
      max = session.sortKey;
    }
  }
  return max;
}
