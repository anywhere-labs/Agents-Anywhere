import { AgentProject, AgentSession, SessionStatus } from '../../model/AgentSession';
import { parseIsoInstantMillis } from './SessionMappers';

/**
 * Recent workspace paths for the new-session page.
 *
 * Port of `feature/sessions/NewSessionWorkspaces.kt`, including the two helpers
 * it borrows from elsewhere in Android (`workspacePathKey` from
 * `WorkspaceProjects.kt`, `timestampMillis` from `SidebarSelectors.kt`), because
 * both exist only in service of this ordering.
 *
 * A workspace is deduplicated by its *path key*, not by its text, so
 * `/Users/me/project/` and `/Users/me/project` are the same workspace, and a
 * Windows path matches whatever casing the Server happened to report.
 */

/** Android's `windowsPath`: an explicit OS, a drive letter, or a UNC prefix. */
function isWindowsPath(path: string, deviceOs: string | null): boolean {
  if (deviceOs === 'windows') {
    return true;
  }
  return /^[a-zA-Z]:[/\\]/.test(path) || path.startsWith('\\\\');
}

/**
 * A canonical comparison key for a workspace path.
 *
 * Backslashes are unified on Windows, `.` segments are dropped, `..` pops on
 * POSIX (where it is meaningful), and Windows keys are lowercased because the
 * file system is case-insensitive.
 */
export function workspacePathKey(path: string, deviceOs: string | null = null): string {
  const trimmed: string = path.trim();
  const windows: boolean = isWindowsPath(trimmed, deviceOs);
  const slashes: string = windows ? trimmed.replace(/\\/g, '/') : trimmed;
  const parts: string[] = [];
  for (const part of slashes.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (!windows && part === '..') {
      if (parts.length > 0) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  let prefix: string = '';
  if (slashes.startsWith('//') && !slashes.startsWith('///')) {
    prefix = '//';
  } else if (slashes.startsWith('/')) {
    prefix = '/';
  }
  const key: string = prefix + parts.join('/');
  return windows ? key.toLowerCase() : key;
}

/**
 * A project name that is free on this account.
 *
 * Port of `WorkspaceProjects.kt`'s `availableProjectName`: the name is trimmed,
 * limited to 255 code points, and suffixed ` (n)` until it collides with no
 * other project (ignoring the one being renamed) and no reserved name.
 */
export function availableProjectName(
  name: string,
  projects: AgentProject[],
  ignoreId: string | null = null,
  reservedNames: Set<string> = new Set(),
): string {
  const base: string = limitCodePoints(name.trim().length > 0 ? name.trim() : 'Workspace', 255);
  const names: Set<string> = new Set(reservedNames);
  for (const project of projects) {
    if (project.id !== ignoreId) {
      names.add(project.name);
    }
  }
  let candidate: string = base;
  let suffix: number = 1;
  while (names.has(candidate)) {
    const ending: string = ` (${suffix})`;
    suffix += 1;
    candidate = limitCodePoints(base, 255 - ending.length) + ending;
  }
  return candidate;
}

/** Truncates on code points, so an emoji is never cut in half. */
function limitCodePoints(value: string, count: number): string {
  const points: string[] = Array.from(value);
  return points.length <= count ? value : points.slice(0, count).join('');
}

/** Android's `timestampMillis`: an ISO instant, or 0 when it cannot be read. */
export function timestampMillis(value: string | null): number {
  return parseIsoInstantMillis(value) ?? 0;
}

/**
 * The project a workspace path belongs to, or `null`.
 *
 * Port of `WorkspaceProjects.kt`'s `workspaceProject`: the comparison goes
 * through `workspacePathKey`, so a path and its trailing-slash spelling are the
 * same workspace.
 */
export function workspaceProject(
  projects: AgentProject[],
  connectorId: string,
  path: string,
  deviceOs: string | null = null,
): AgentProject | null {
  const key: string = workspacePathKey(path, deviceOs);
  if (key.length === 0) {
    return null;
  }
  for (const project of projects) {
    if (project.connectorId === connectorId && workspacePathKey(project.workspacePath, deviceOs) === key) {
      return project;
    }
  }
  return null;
}

/**
 * The label a directory gets when it has no project.
 *
 * Port of `WorkspaceProjects.kt`'s `workspaceProjectName`: a bare drive or UNC
 * share is called "Workspace" because its last segment would be meaningless.
 */
export function workspaceProjectName(path: string): string {
  const windows: boolean = isWindowsPath(path, null);
  const trimmed: string = windows ? path.trim().replace(/\\/g, '/') : path.trim();
  const normalized: string = trimmed.replace(/\/+$/, '');
  if (windows && (/^[a-zA-Z]:$/.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized))) {
    return 'Workspace';
  }
  const afterSlash: string = normalized.substring(normalized.lastIndexOf('/') + 1);
  return afterSlash.length > 0 ? afterSlash : 'Workspace';
}

/** Android's `workspaceSessionComparator`: running first, then newest. */
function compareWorkspaceSessions(
  left: AgentSession,
  right: AgentSession,
  topUntil: Map<string, number>,
  now: number,
): number {
  const leftRunning: boolean = left.status === SessionStatus.Running
    || (topUntil.get(left.id) ?? 0) > now;
  const rightRunning: boolean = right.status === SessionStatus.Running
    || (topUntil.get(right.id) ?? 0) > now;
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    return compareStrings(left.id, right.id);
  }
  const byTime: number = timestampMillis(right.sortAt) - timestampMillis(left.sortAt);
  return byTime !== 0 ? byTime : compareStrings(right.id, left.id);
}

/** Android's `workspaceProjectComparator`: pinned first, then most recent. */
function compareWorkspaceProjects(left: AgentProject, right: AgentProject): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  const leftAt: string = nonEmpty(left.pinnedAt) ?? nonEmpty(left.lastActivityAt) ?? left.updatedAt;
  const rightAt: string = nonEmpty(right.pinnedAt) ?? nonEmpty(right.lastActivityAt) ?? right.updatedAt;
  const byTime: number = timestampMillis(rightAt) - timestampMillis(leftAt);
  if (byTime !== 0) {
    return byTime;
  }
  // Android orders by a locale `Collator` here; `localeCompare` is the closest
  // equivalent the platform offers.
  const byName: number = left.name.localeCompare(right.name);
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function nonEmpty(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

/**
 * The workspaces the user has actually used on a device, most recent first.
 *
 * The order is Desktop's combined order: sessions (running ones first) followed
 * by projects, deduplicated by path key, with the home directory removed because
 * the page always offers it as an explicit entry.
 */
export function recentWorkspacePaths(
  connectorId: string | null,
  deviceOs: string | null,
  homePath: string | null,
  sessions: AgentSession[],
  projects: AgentProject[],
  now: number = Date.now(),
): string[] {
  if (connectorId === null || connectorId.trim().length === 0) {
    return [];
  }

  const sessionsById: Map<string, AgentSession> = new Map();
  const topUntil: Map<string, number> = new Map();
  for (const session of sessions) {
    if (session.connectorId !== connectorId) {
      continue;
    }
    const current: AgentSession | undefined = sessionsById.get(session.id);
    const latest: AgentSession = current === undefined || session.updatedSeq >= current.updatedSeq
      ? session : current;
    sessionsById.set(session.id, latest);
    const previousTop: number = topUntil.get(session.id) ?? 0;
    topUntil.set(session.id, Math.max(previousTop, session.optimisticTopUntil));
  }

  const ordered: AgentSession[] = Array.from(sessionsById.values())
    .sort((left: AgentSession, right: AgentSession) => compareWorkspaceSessions(left, right, topUntil, now));
  const sessionPaths: string[] = [];
  for (const session of ordered) {
    if (session.cwd !== null) {
      sessionPaths.push(session.cwd);
    }
  }

  const projectPaths: string[] = [];
  const deviceProjects: AgentProject[] = projects
    .filter((project: AgentProject) => project.connectorId === connectorId);
  deviceProjects.sort(compareWorkspaceProjects);
  for (const project of deviceProjects) {
    projectPaths.push(project.workspacePath);
  }

  const homeKey: string = workspacePathKey(homePath ?? '', deviceOs);
  const seen: Set<string> = new Set();
  const result: string[] = [];
  for (const path of sessionPaths.concat(projectPaths)) {
    if (path.trim().length === 0) {
      continue;
    }
    const key: string = workspacePathKey(path, deviceOs);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (key === homeKey) {
      continue;
    }
    result.push(path);
  }
  return result;
}
