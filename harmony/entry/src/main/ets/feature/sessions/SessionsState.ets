import { AgentDevice, AgentProject, AgentSession } from '../../model/AgentSession';
import { DashboardSnapshot } from '../../api/RealtimeDtos';
import { compareArchivedSessions, compareSessions, toAgentSession } from './SessionMappers';

/**
 * Sessions page state.
 *
 * Port of `feature/sessions/SessionsState.kt`.
 *
 * The state is replaced rather than mutated: ArkUI tracks a `@State` field by
 * reference, so every operation returns a new instance. That also makes the
 * "authoritative vs observed" merge explicit, which is the whole point of the
 * generation counters below.
 *
 * Generation counters exist to stop a slow HTTP read from undoing a newer
 * dashboard push. `beginSessionRequest` bumps the generation for the ids it is
 * about to fetch, and a response is only applied when its generation is still
 * current.
 */

/** Optional overrides for `SessionsState.copy`. */
export interface SessionsStatePatch {
  sessions?: AgentSession[];
  archivedSessions?: AgentSession[];
  projects?: AgentProject[];
  devices?: AgentDevice[];
  isLoading?: boolean;
  errorMessage?: string | null;
  hasLoaded?: boolean;
  activeHasMore?: boolean;
  activeNextCursor?: string | null;
  archivedHasMore?: boolean;
  archivedNextCursor?: string | null;
  isLoadingMoreActive?: boolean;
  isLoadingMoreArchived?: boolean;
  activeFirstPageIds?: string[];
  archivedFirstPageIds?: string[];
}

export class SessionsState {
  readonly sessions: AgentSession[];
  readonly archivedSessions: AgentSession[];
  readonly projects: AgentProject[];
  readonly devices: AgentDevice[];
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
  readonly hasLoaded: boolean;
  readonly activeHasMore: boolean;
  readonly activeNextCursor: string | null;
  readonly archivedHasMore: boolean;
  readonly archivedNextCursor: string | null;
  readonly isLoadingMoreActive: boolean;
  readonly isLoadingMoreArchived: boolean;
  readonly activeFirstPageIds: string[];
  readonly archivedFirstPageIds: string[];
  private readonly generations: Map<string, number>;
  private readonly nextGeneration: number;

  constructor(
    sessions: AgentSession[],
    archivedSessions: AgentSession[],
    projects: AgentProject[],
    devices: AgentDevice[],
    isLoading: boolean,
    errorMessage: string | null,
    hasLoaded: boolean,
    activeHasMore: boolean,
    activeNextCursor: string | null,
    archivedHasMore: boolean,
    archivedNextCursor: string | null,
    isLoadingMoreActive: boolean,
    isLoadingMoreArchived: boolean,
    activeFirstPageIds: string[],
    archivedFirstPageIds: string[],
    generations: Map<string, number>,
    nextGeneration: number,
  ) {
    this.sessions = sessions;
    this.archivedSessions = archivedSessions;
    this.projects = projects;
    this.devices = devices;
    this.isLoading = isLoading;
    this.errorMessage = errorMessage;
    this.hasLoaded = hasLoaded;
    this.activeHasMore = activeHasMore;
    this.activeNextCursor = activeNextCursor;
    this.archivedHasMore = archivedHasMore;
    this.archivedNextCursor = archivedNextCursor;
    this.isLoadingMoreActive = isLoadingMoreActive;
    this.isLoadingMoreArchived = isLoadingMoreArchived;
    this.activeFirstPageIds = activeFirstPageIds;
    this.archivedFirstPageIds = archivedFirstPageIds;
    this.generations = generations;
    this.nextGeneration = nextGeneration;
  }

  static empty(): SessionsState {
    return new SessionsState(
      [], [], [], [], false, null, false,
      false, null, false, null, false, false,
      [], [], new Map<string, number>(), 1,
    );
  }

  copy(patch: SessionsStatePatch): SessionsState {
    return new SessionsState(
      patch.sessions ?? this.sessions,
      patch.archivedSessions ?? this.archivedSessions,
      patch.projects ?? this.projects,
      patch.devices ?? this.devices,
      patch.isLoading ?? this.isLoading,
      patch.errorMessage !== undefined ? patch.errorMessage : this.errorMessage,
      patch.hasLoaded ?? this.hasLoaded,
      patch.activeHasMore ?? this.activeHasMore,
      patch.activeNextCursor !== undefined ? patch.activeNextCursor : this.activeNextCursor,
      patch.archivedHasMore ?? this.archivedHasMore,
      patch.archivedNextCursor !== undefined ? patch.archivedNextCursor : this.archivedNextCursor,
      patch.isLoadingMoreActive ?? this.isLoadingMoreActive,
      patch.isLoadingMoreArchived ?? this.isLoadingMoreArchived,
      patch.activeFirstPageIds ?? this.activeFirstPageIds,
      patch.archivedFirstPageIds ?? this.archivedFirstPageIds,
      this.generations,
      this.nextGeneration,
    );
  }

  /** Device lookup for name resolution in the session mapper. */
  devicesById(): Map<string, AgentDevice> {
    const map: Map<string, AgentDevice> = new Map();
    for (const device of this.devices) {
      map.set(device.id, device);
    }
    return map;
  }

  /** Active sessions in display order. */
  sortedSessions(): AgentSession[] {
    return this.sessions.slice().sort(compareSessions);
  }

  pinnedSessions(): AgentSession[] {
    return this.sortedSessions().filter((session: AgentSession) => session.pinned);
  }

  recentSessions(): AgentSession[] {
    return this.sortedSessions().filter((session: AgentSession) => !session.pinned);
  }

  sortedArchivedSessions(): AgentSession[] {
    return this.archivedSessions.slice().sort(compareArchivedSessions);
  }

  sessionsForProject(projectId: string): AgentSession[] {
    return this.sortedSessions()
      .filter((session: AgentSession) => session.projectId === projectId);
  }

  activeSessionCountForProject(projectId: string): number {
    let count: number = 0;
    for (const session of this.sessions) {
      if (session.projectId === projectId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Reserves generations for the given ids and returns the bumped state.
   *
   * Call this before issuing a read whose result must not clobber a push that
   * arrives while the read is in flight.
   */
  beginSessionRequest(ids: string[]): SessionsState {
    const generations: Map<string, number> = new Map(this.generations);
    let next: number = this.nextGeneration;
    for (const id of ids) {
      generations.set(id, next);
      next += 1;
    }
    return new SessionsState(
      this.sessions, this.archivedSessions, this.projects, this.devices,
      this.isLoading, this.errorMessage, this.hasLoaded,
      this.activeHasMore, this.activeNextCursor,
      this.archivedHasMore, this.archivedNextCursor,
      this.isLoadingMoreActive, this.isLoadingMoreArchived,
      this.activeFirstPageIds, this.archivedFirstPageIds,
      generations, next,
    );
  }

  generationFor(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /** True when the response for this id is still the newest request. */
  isCurrentGeneration(sessionId: string, generation: number): boolean {
    return generation !== 0 && this.generationFor(sessionId) === generation;
  }

  /**
   * Replaces the whole list from a dashboard snapshot.
   *
   * Locally-created sessions that the snapshot has not caught up with are kept
   * when they are newer than the snapshot's first page, matching Android's
   * `replacedByDashboardSnapshot`.
   */
  replacedByDashboardSnapshot(snapshot: DashboardSnapshot, devices: AgentDevice[]): SessionsState {
    const devicesById: Map<string, AgentDevice> = new Map();
    for (const device of devices.length > 0 ? devices : snapshot.devices) {
      devicesById.set(device.id, device);
    }
    const mapped: AgentSession[] = [];
    for (const dto of snapshot.sessions) {
      mapped.push(toAgentSession(dto, devicesById));
    }
    const active: AgentSession[] = [];
    const archived: AgentSession[] = [];
    for (const session of mapped) {
      if (session.archived) {
        archived.push(session);
      } else {
        active.push(session);
      }
    }
    return this.copy({
      sessions: active,
      archivedSessions: archived.length > 0 ? archived : this.archivedSessions,
      projects: snapshot.projects,
      devices: devices.length > 0 ? devices : snapshot.devices,
      isLoading: false,
      errorMessage: null,
      hasLoaded: true,
      activeHasMore: snapshot.activePage.hasMore,
      activeNextCursor: snapshot.activePage.nextCursor,
      archivedHasMore: snapshot.archivedPage.hasMore,
      archivedNextCursor: snapshot.archivedPage.nextCursor,
      activeFirstPageIds: active.map((session: AgentSession) => session.id),
    });
  }

  /**
   * Applies an authoritative session returned by a mutation.
   *
   * A session moves between the active and archived lists when its `archived`
   * flag changed, and the lists are re-sorted afterwards.
   */
  withPatchedSession(session: AgentSession): SessionsState {
    const active: AgentSession[] = [];
    const archived: AgentSession[] = [];
    let replaced: boolean = false;

    for (const existing of this.sessions) {
      if (existing.id === session.id) {
        replaced = true;
        if (!session.archived) {
          active.push(session);
        }
      } else {
        active.push(existing);
      }
    }
    for (const existing of this.archivedSessions) {
      if (existing.id === session.id) {
        replaced = true;
        if (session.archived) {
          archived.push(session);
        }
      } else {
        archived.push(existing);
      }
    }
    if (!replaced) {
      if (session.archived) {
        archived.push(session);
      } else {
        active.push(session);
      }
    }
    return this.copy({
      sessions: active.sort(compareSessions),
      archivedSessions: archived.sort(compareArchivedSessions),
    });
  }

  withPatchedSessions(updated: AgentSession[]): SessionsState {
    let next: SessionsState = this;
    for (const session of updated) {
      next = next.withPatchedSession(session);
    }
    return next;
  }

  /** Removes sessions the Server reported as gone. */
  withMissingSessionsRemoved(missingIds: string[]): SessionsState {
    if (missingIds.length === 0) {
      return this;
    }
    const gone: Set<string> = new Set(missingIds);
    return this.copy({
      sessions: this.sessions.filter((session: AgentSession) => !gone.has(session.id)),
      archivedSessions: this.archivedSessions.filter((session: AgentSession) => !gone.has(session.id)),
    });
  }

  /** Appends one page of an archived or active list. */
  withAppendedSessionPage(page: AgentSession[], archived: boolean, nextCursor: string | null, hasMore: boolean): SessionsState {
    if (archived) {
      return this.copy({
        archivedSessions: dedupeById(this.archivedSessions.concat(page)),
        archivedNextCursor: nextCursor,
        archivedHasMore: hasMore,
        isLoadingMoreArchived: false,
      });
    }
    return this.copy({
      sessions: dedupeById(this.sessions.concat(page)),
      activeNextCursor: nextCursor,
      activeHasMore: hasMore,
      isLoadingMoreActive: false,
    });
  }

  /** Replaces one project with the authoritative row the Server returned. */
  withPatchedProject(project: AgentProject): SessionsState {
    const projects: AgentProject[] = [];
    let replaced: boolean = false;
    for (const existing of this.projects) {
      if (existing.id === project.id) {
        replaced = true;
        projects.push(project);
      } else {
        projects.push(existing);
      }
    }
    if (!replaced) {
      projects.push(project);
    }
    return this.copy({ projects: projects });
  }

  withPatchedDevice(device: AgentDevice): SessionsState {    const devices: AgentDevice[] = [];
    let replaced: boolean = false;
    for (const existing of this.devices) {
      if (existing.id === device.id) {
        replaced = true;
        devices.push(device);
      } else {
        devices.push(existing);
      }
    }
    if (!replaced) {
      devices.push(device);
    }
    // Session rows carry the device name, so they are re-mapped to stay in sync.
    const devicesById: Map<string, AgentDevice> = new Map();
    for (const entry of devices) {
      devicesById.set(entry.id, entry);
    }
    return this.copy({
      devices: devices,
      sessions: this.sessions.map((session: AgentSession) =>
        session.connectorId === device.id ? replaceDeviceName(session, device.name) : session),
      archivedSessions: this.archivedSessions.map((session: AgentSession) =>
        session.connectorId === device.id ? replaceDeviceName(session, device.name) : session),
    });
  }

  /** Drops a device together with its projects and sessions. */
  withDeletedDevice(deviceId: string): SessionsState {
    return this.copy({
      devices: this.devices.filter((device: AgentDevice) => device.id !== deviceId),
      projects: this.projects.filter((project: AgentProject) => project.connectorId !== deviceId),
      sessions: this.sessions.filter((session: AgentSession) => session.connectorId !== deviceId),
      archivedSessions: this.archivedSessions
        .filter((session: AgentSession) => session.connectorId !== deviceId),
    });
  }
}

function replaceDeviceName(session: AgentSession, deviceName: string): AgentSession {
  const label: string = session.runtimeLabel;
  const parts: string[] = [label];
  if (deviceName.length > 0) {
    parts.push(deviceName);
  }
  if (session.workspaceLabel.length > 0) {
    parts.push(session.workspaceLabel);
  }
  return {
    id: session.id,
    connectorId: session.connectorId,
    projectId: session.projectId,
    deviceName: deviceName,
    title: session.title,
    summary: session.summary,
    cwd: session.cwd,
    workspaceLabel: session.workspaceLabel,
    runtime: session.runtime,
    runtimeLabel: session.runtimeLabel,
    status: session.status,
    statusLabel: session.statusLabel,
    updatedAtLabel: session.updatedAtLabel,
    metaLabel: parts.join('  ·  '),
    pinned: session.pinned,
    archived: session.archived,
    unread: session.unread,
    lastReadSeq: session.lastReadSeq,
    takeover: session.takeover,
    connectorOnline: session.connectorOnline,
    live: session.live,
    sortKey: session.sortKey,
    updatedSeq: session.updatedSeq,
    runtimeId: session.runtimeId,
    runtimeType: session.runtimeType,
    runtimeName: session.runtimeName,
    archivedAt: session.archivedAt,
    optimisticTopUntil: session.optimisticTopUntil,
    sortAt: session.sortAt,
  };
}

function dedupeById(sessions: AgentSession[]): AgentSession[] {
  const seen: Set<string> = new Set();
  const out: AgentSession[] = [];
  for (const session of sessions) {
    if (!seen.has(session.id)) {
      seen.add(session.id);
      out.push(session);
    }
  }
  return out;
}
