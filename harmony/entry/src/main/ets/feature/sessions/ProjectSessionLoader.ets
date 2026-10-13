import { AgentDevice, AgentSession } from '../../model/AgentSession';
import { RemoteSession, RemoteSessionPage } from '../../api/SessionsDtos';
import { SessionsApi } from '../../api/SessionsApi';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { AASemaphore } from '../../common/AASemaphore';
import { toAgentSession } from './SessionMappers';
import { AALog } from '../../common/AAAppLog';

/**
 * Lazy per-project session loading, with cache and concurrency limits.
 *
 * Port of the project-session block in `app/AgentsAnywhereApp.kt`.
 *
 * Expanding a project must not stall the list, and refreshing must not refetch
 * every project, so a read is skipped when the same `(projectId, archived)` pair
 * was loaded less than 30 seconds ago or is already in flight. At most three
 * reads run at once.
 *
 * The whole project history is fetched, not just the first page, so an expanded
 * project is complete rather than showing only what happens to be in the first
 * hundred sessions.
 */

/** How long a project's session list stays fresh. */
const CACHE_TTL_MS: number = 30_000;
/** Concurrent project reads, matching Android's `Semaphore(3)`. */
const MAX_CONCURRENT_LOADS: number = 3;
/** Page size for the walk through a project's history. */
const PAGE_LIMIT: number = 100;

function cacheKey(projectId: string, archived: boolean): string {
  return `${projectId}|${archived ? 'archived' : 'active'}`;
}

export class ProjectSessionLoader {
  private readonly sessionsApi: SessionsApi;
  private readonly sessionStore: AuthSessionStore;
  private readonly slots: AASemaphore = new AASemaphore(MAX_CONCURRENT_LOADS);

  /** When each key was last loaded, for the freshness check. */
  private readonly loadedAt: Map<string, number> = new Map();
  /** Keys with a read in flight, so a second expand does not duplicate it. */
  private readonly inFlight: Set<string> = new Set();

  constructor(sessionsApi: SessionsApi, sessionStore: AuthSessionStore) {
    this.sessionsApi = sessionsApi;
    this.sessionStore = sessionStore;
  }

  isInFlight(projectId: string, archived: boolean): boolean {
    return this.inFlight.has(cacheKey(projectId, archived));
  }

  isFresh(projectId: string, archived: boolean): boolean {
    const loadedAt: number | undefined = this.loadedAt.get(cacheKey(projectId, archived));
    if (loadedAt === undefined) {
      return false;
    }
    return Date.now() - loadedAt < CACHE_TTL_MS;
  }

  /**
   * Loads one `(projectId, archived)` pair unless it is fresh or in flight.
   *
   * The token and project existence are re-checked after the permit is acquired
   * so a sign-out or project deletion during the wait cannot apply a stale list.
   */
  async ensureLoaded(
    projectId: string,
    archived: boolean,
    devices: AgentDevice[],
    projectStillExists: () => boolean,
    onLoaded: (projectId: string, archived: boolean, sessions: AgentSession[]) => void,
    onError: (projectId: string, archived: boolean, message: string) => void,
  ): Promise<void> {
    if (projectId.length === 0) {
      return;
    }
    const key: string = cacheKey(projectId, archived);
    if (this.inFlight.has(key) || this.isFresh(projectId, archived)) {
      return;
    }
    this.inFlight.add(key);
    const token: string = this.sessionStore.readAccessToken();
    try {
      await this.slots.withPermit(async () => {
        if (this.sessionStore.readAccessToken() !== token || !projectStillExists()) {
          return;
        }
        try {
          const sessions: AgentSession[] = await this.fetchAllPages(projectId, archived, devices);
          if (this.sessionStore.readAccessToken() !== token || !projectStillExists()) {
            return;
          }
          this.loadedAt.set(key, Date.now());
          onLoaded(projectId, archived, sessions);
        } catch (error) {
          const message: string = error instanceof Error
            ? error.message
            : 'Could not load project sessions.';
          AALog.warn(`Project session load failed for ${projectId}: ${message}`);
          if (this.sessionStore.readAccessToken() === token) {
            onError(projectId, archived, message);
          }
        }
      });
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Walks every page of a project's sessions.
   *
   * A repeated cursor ends the walk, which is the same guard Android uses to
   * tolerate a Server that reports `hasMore` with an unchanged cursor.
   */
  private async fetchAllPages(
    projectId: string,
    archived: boolean,
    devices: AgentDevice[],
  ): Promise<AgentSession[]> {
    const serverUrl: string = this.sessionStore.readServerUrl();
    const token: string = this.sessionStore.readAccessToken();
    const collected: RemoteSession[] = [];
    const seenCursors: Set<string> = new Set();
    let cursor: string | null = null;

    while (true) {
      const page: RemoteSessionPage = await this.sessionsApi.listForProject(
        serverUrl, token, projectId, archived, PAGE_LIMIT, cursor,
      );
      for (const session of page.sessions) {
        collected.push(session);
      }
      const nextCursor: string | null = page.nextCursor;
      if (nextCursor === null || nextCursor.length === 0) {
        break;
      }
      if (!page.hasMore || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const devicesById: Map<string, AgentDevice> = new Map();
    for (const device of devices) {
      devicesById.set(device.id, device);
    }
    const byId: Map<string, AgentSession> = new Map();
    for (const dto of collected) {
      byId.set(dto.id, toAgentSession(dto, devicesById));
    }
    return Array.from(byId.values());
  }

  /** Drops the cache; called on sign-out so a new account cannot see old lists. */
  reset(): void {
    this.loadedAt.clear();
    this.inFlight.clear();
  }
}
