import { AgentSession } from '../../model/AgentSession';
import { compareArchivedSessions, compareSessions } from './SessionMappers';

/**
 * Project session lists loaded on demand.
 *
 * Port of the `projectSessionsById` / `loadingProjectRequests` /
 * `projectSessionErrors` triple in `app/AgentsAnywhereApp.kt`.
 *
 * Kept apart from `SessionsState` because it is a lazily-populated cache keyed by
 * project rather than the canonical dashboard list, and because every field is
 * replaced wholesale (ArkUI tracks a `@State` field by reference).
 */

/** Which archived states the project tree is showing. */
export enum ProjectSessionStatusFilter {
  Active = 0,
  Archived = 1,
  All = 2,
}

/** The archived states a filter expands to, matching Android's `archiveStates`. */
export function archiveStatesFor(filter: ProjectSessionStatusFilter): boolean[] {
  if (filter === ProjectSessionStatusFilter.Archived) {
    return [true];
  }
  if (filter === ProjectSessionStatusFilter.All) {
    return [false, true];
  }
  return [false];
}

/** Cache key for one `(projectId, archived)` pair. */
export function projectSessionKey(projectId: string, archived: boolean): string {
  return `${projectId}|${archived ? 'archived' : 'active'}`;
}

export class ProjectSessionsState {
  readonly byProjectId: Map<string, AgentSession[]>;
  readonly loadingKeys: Set<string>;
  readonly errors: Map<string, string>;

  constructor(
    byProjectId: Map<string, AgentSession[]>,
    loadingKeys: Set<string>,
    errors: Map<string, string>,
  ) {
    this.byProjectId = byProjectId;
    this.loadingKeys = loadingKeys;
    this.errors = errors;
  }

  static empty(): ProjectSessionsState {
    return new ProjectSessionsState(
      new Map<string, AgentSession[]>(), new Set<string>(), new Map<string, string>(),
    );
  }

  /**
   * Merges a freshly loaded list for one archived state.
   *
   * Entries belonging to the *other* archived state are retained, so loading the
   * active list never discards an already-loaded archived list for the project.
   */
  withLoaded(projectId: string, archived: boolean, sessions: AgentSession[]): ProjectSessionsState {
    const byProjectId: Map<string, AgentSession[]> = new Map(this.byProjectId);
    const existing: AgentSession[] = byProjectId.get(projectId) ?? [];
    const retained: AgentSession[] = existing.filter(
      (session: AgentSession) => session.archived !== archived,
    );
    const merged: Map<string, AgentSession> = new Map();
    for (const session of retained) {
      merged.set(session.id, session);
    }
    for (const session of sessions) {
      merged.set(session.id, session);
    }
    byProjectId.set(projectId, Array.from(merged.values()));
    return new ProjectSessionsState(byProjectId, this.copyLoading(), this.copyErrors());
  }

  withLoading(key: string): ProjectSessionsState {
    const loadingKeys: Set<string> = this.copyLoading();
    loadingKeys.add(key);
    const errors: Map<string, string> = this.copyErrors();
    errors.delete(key);
    return new ProjectSessionsState(this.byProjectId, loadingKeys, errors);
  }

  withLoadingCleared(key: string): ProjectSessionsState {
    const loadingKeys: Set<string> = this.copyLoading();
    loadingKeys.delete(key);
    return new ProjectSessionsState(this.byProjectId, loadingKeys, this.copyErrors());
  }

  withError(key: string, message: string): ProjectSessionsState {
    const errors: Map<string, string> = this.copyErrors();
    errors.set(key, message);
    return new ProjectSessionsState(this.byProjectId, this.copyLoading(), errors);
  }

  isLoading(projectId: string, archived: boolean): boolean {
    return this.loadingKeys.has(projectSessionKey(projectId, archived));
  }

  errorFor(projectId: string, archived: boolean): string | null {
    return this.errors.get(projectSessionKey(projectId, archived)) ?? null;
  }

  /** Any error for the project, regardless of which list it came from. */
  anyErrorFor(projectId: string): string | null {
    for (const archived of [false, true]) {
      const message: string | null = this.errorFor(projectId, archived);
      if (message !== null) {
        return message;
      }
    }
    return null;
  }

  isLoadingAny(projectId: string): boolean {
    return this.isLoading(projectId, false) || this.isLoading(projectId, true);
  }

  /**
   * Sessions to show under a project, ordered per list kind.
   *
   * When the project has never been loaded the caller-supplied fallback is used,
   * so the tree shows whatever the dashboard already knows instead of nothing
   * while the project fetch is still in flight.
   */
  sessionsFor(
    projectId: string,
    filter: ProjectSessionStatusFilter,
    fallback: AgentSession[],
  ): AgentSession[] {
    const loaded: AgentSession[] | undefined = this.byProjectId.get(projectId);
    const source: AgentSession[] = loaded ?? fallback;
    const wanted: boolean[] = archiveStatesFor(filter);
    const active: AgentSession[] = [];
    const archived: AgentSession[] = [];
    for (const session of source) {
      if (wanted.includes(session.archived)) {
        if (session.archived) {
          archived.push(session);
        } else {
          active.push(session);
        }
      }
    }
    // Archive time is the right order for the archived half, activity for active.
    return active.sort(compareSessions).concat(archived.sort(compareArchivedSessions));
  }

  /** Drops everything; called on sign-out. */
  cleared(): ProjectSessionsState {
    return ProjectSessionsState.empty();
  }

  private copyLoading(): Set<string> {
    const copy: Set<string> = new Set();
    this.loadingKeys.forEach((key: string) => {
      copy.add(key);
    });
    return copy;
  }

  private copyErrors(): Map<string, string> {
    return new Map(this.errors);
  }
}
