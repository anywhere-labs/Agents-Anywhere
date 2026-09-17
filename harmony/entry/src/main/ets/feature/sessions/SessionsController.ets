import { AgentDevice, AgentProject, AgentSession } from '../../model/AgentSession';
import { DevicesApi } from '../../api/DevicesApi';
import { ProjectsApi } from '../../api/ProjectsApi';
import { SessionsApi, RemoteInlineAttachmentRef, RemoteSessionCreateAndStartRequest } from '../../api/SessionsApi';
import { FilesApi } from '../../api/FilesApi';
import { RemoteDirectory } from '../../api/FilesDtos';
import { AALog } from '../../common/AAAppLog';
import { AAApiError } from '../../api/ApiError';
import {
  NewSessionAttachmentPart, NewSessionCreateDraft, NewSessionCreateOutcome, newCreateCandidates,
  toInlineAttachmentRef, validateNewSessionDraft,
} from './NewSessionState';
import { resolveWorkspaceProject } from './WorkspaceProjectResolver';
import { DashboardSnapshot } from '../../api/RealtimeDtos';
import { RemoteSession, RemoteSessionBatch, RemoteSessionEnvelope, RemoteSessionPage } from '../../api/SessionsDtos';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { SessionsState } from './SessionsState';
import { toAgentSession } from './SessionMappers';

/**
 * Session list workflows.
 *
 * Port of `feature/sessions/SessionsController.kt`.
 *
 * The controller takes the current state and returns the next one; the screen
 * owns the `@State` field. That keeps every transition in one readable place and
 * matches how ArkUI decides to redraw.
 */
export class SessionsController {  private readonly sessionsApi: SessionsApi;
  private readonly projectsApi: ProjectsApi;
  private readonly devicesApi: DevicesApi;
  private readonly filesApi: FilesApi;
  private readonly sessionStore: AuthSessionStore;

  constructor(
    sessionsApi: SessionsApi,
    projectsApi: ProjectsApi,
    devicesApi: DevicesApi,
    filesApi: FilesApi,
    sessionStore: AuthSessionStore,
  ) {
    this.sessionsApi = sessionsApi;
    this.projectsApi = projectsApi;
    this.devicesApi = devicesApi;
    this.filesApi = filesApi;
    this.sessionStore = sessionStore;
  }

  private serverUrl(): string {
    return this.sessionStore.readServerUrl();
  }

  private token(): string {
    return this.sessionStore.readAccessToken();
  }

  /**
   * First load: devices and projects in parallel with the first session page.
   *
   * Devices are fetched first because session rows resolve their device name
   * during mapping.
   */
  async loadInitial(state: SessionsState): Promise<SessionsState> {
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    let loading: SessionsState = state.copy({
      isLoading: true,
      errorMessage: null,
    });
    try {
      const devices: AgentDevice[] = await this.devicesApi.list(serverUrl, token);
      loading = loading.copy({ devices: devices });
      const projects: AgentProject[] = await this.projectsApi.list(serverUrl, token);
      const page: RemoteSessionPage = await this.sessionsApi.list(serverUrl, token, false);
      const devicesById: Map<string, AgentDevice> = loading.devicesById();
      const active: AgentSession[] = page.sessions.map((dto: RemoteSession) =>
        toAgentSession(dto, devicesById));
      return loading.copy({
        projects: projects,
        sessions: active,
        isLoading: false,
        hasLoaded: true,
        errorMessage: null,
        activeHasMore: page.hasMore && page.nextCursor !== null,
        activeNextCursor: page.nextCursor,
        activeFirstPageIds: active.map((session: AgentSession) => session.id),
      });
    } catch (error) {
      return loading.copy({
        isLoading: false,
        // A failure only surfaces when there is nothing cached to show.
        errorMessage: state.hasLoaded
          ? null
          : (error instanceof Error ? error.message : 'Could not load sessions.'),
      });
    }
  }

  /** Pull-to-refresh and the dashboard fallback. */
  async refresh(state: SessionsState, showInitialLoading: boolean): Promise<SessionsState> {
    if (state.isLoading && !showInitialLoading) {
      return state;
    }
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    let next: SessionsState = state.copy({
      isLoading: showInitialLoading,
      errorMessage: null,
    });
    try {
      const devices: AgentDevice[] = await this.devicesApi.list(serverUrl, token);
      next = next.copy({ devices: devices });
      const projects: AgentProject[] = await this.projectsApi.list(serverUrl, token);
      const page: RemoteSessionPage = await this.sessionsApi.list(serverUrl, token, false);
      const devicesById: Map<string, AgentDevice> = next.devicesById();
      const active: AgentSession[] = page.sessions.map((dto: RemoteSession) =>
        toAgentSession(dto, devicesById));
      return next.copy({
        projects: projects,
        sessions: active,
        isLoading: false,
        hasLoaded: true,
        errorMessage: null,
        activeHasMore: page.hasMore && page.nextCursor !== null,
        activeNextCursor: page.nextCursor,
        activeFirstPageIds: active.map((session: AgentSession) => session.id),
      });
    } catch (error) {
      return next.copy({
        isLoading: false,
        errorMessage: state.hasLoaded
          ? null
          : (error instanceof Error ? error.message : 'Could not load sessions.'),
      });
    }
  }

  /** Loads the next page of active sessions. */
  async loadMoreActive(state: SessionsState): Promise<SessionsState> {
    const cursor: string | null = state.activeNextCursor;
    if (cursor === null || !state.activeHasMore || state.isLoadingMoreActive) {
      return state;
    }
    let next: SessionsState = state.copy({ isLoadingMoreActive: true });
    try {
      const page: RemoteSessionPage = await this.sessionsApi.list(
        this.serverUrl(), this.token(), false, 100, cursor,
      );
      const devicesById: Map<string, AgentDevice> = next.devicesById();
      const mapped: AgentSession[] = page.sessions.map((dto: RemoteSession) =>
        toAgentSession(dto, devicesById));
      return next.withAppendedSessionPage(
        mapped, false, page.nextCursor, page.hasMore && page.nextCursor !== null,
      );
    } catch (error) {
      return next.copy({ isLoadingMoreActive: false });
    }
  }

  /** Loads the next page of archived sessions. */
  async loadMoreArchived(state: SessionsState): Promise<SessionsState> {
    const cursor: string | null = state.archivedNextCursor;
    if (cursor === null || !state.archivedHasMore || state.isLoadingMoreArchived) {
      return state;
    }
    let next: SessionsState = state.copy({ isLoadingMoreArchived: true });
    try {
      const page: RemoteSessionPage = await this.sessionsApi.list(
        this.serverUrl(), this.token(), true, 100, cursor,
      );
      const devicesById: Map<string, AgentDevice> = next.devicesById();
      const mapped: AgentSession[] = page.sessions.map((dto: RemoteSession) =>
        toAgentSession(dto, devicesById));
      return next.withAppendedSessionPage(
        mapped, true, page.nextCursor, page.hasMore && page.nextCursor !== null,
      );
    } catch (error) {
      return next.copy({ isLoadingMoreArchived: false });
    }
  }

  /** Loads the first archived page when the archived screen is opened. */
  async loadArchived(state: SessionsState): Promise<SessionsState> {
    try {
      const page: RemoteSessionPage = await this.sessionsApi.list(
        this.serverUrl(), this.token(), true,
      );
      const devicesById: Map<string, AgentDevice> = state.devicesById();
      const mapped: AgentSession[] = page.sessions.map((dto: RemoteSession) =>
        toAgentSession(dto, devicesById));
      return state.copy({
        archivedSessions: mapped,
        archivedNextCursor: page.nextCursor,
        archivedHasMore: page.hasMore && page.nextCursor !== null,
        archivedFirstPageIds: mapped.map((session: AgentSession) => session.id),
      });
    } catch (error) {
      return state;
    }
  }

  async rename(state: SessionsState, sessionId: string, title: string): Promise<SessionsState> {
    const envelope: RemoteSessionEnvelope = await this.sessionsApi.patchMeta(
      this.serverUrl(), this.token(), sessionId, title, null, null,
    );
    return state.withPatchedSession(toAgentSession(envelope.session, state.devicesById()));
  }

  async setPinned(state: SessionsState, sessionId: string, pinned: boolean): Promise<SessionsState> {
    const envelope: RemoteSessionEnvelope = await this.sessionsApi.patchMeta(
      this.serverUrl(), this.token(), sessionId, null, pinned, null,
    );
    return state.withPatchedSession(toAgentSession(envelope.session, state.devicesById()));
  }

  async setArchived(state: SessionsState, sessionId: string, archived: boolean): Promise<SessionsState> {
    const envelope: RemoteSessionEnvelope = await this.sessionsApi.patchMeta(
      this.serverUrl(), this.token(), sessionId, null, null, archived,
    );
    return state.withPatchedSession(toAgentSession(envelope.session, state.devicesById()));
  }

  /** Marks sessions read and applies the authoritative rows the Server returns. */
  async markRead(state: SessionsState, sessionIds: string[]): Promise<SessionsState> {
    if (sessionIds.length === 0) {
      return state;
    }
    const batch: RemoteSessionBatch = await this.sessionsApi.markRead(
      this.serverUrl(), this.token(), sessionIds,
    );
    const devicesById: Map<string, AgentDevice> = state.devicesById();
    return state.withPatchedSessions(
      batch.sessions.map((dto: RemoteSession) => toAgentSession(dto, devicesById)),
    );
  }

  /** Bulk archive or unarchive, reconciling rows the Server no longer has. */
  async setArchivedBulk(
    state: SessionsState,
    sessionIds: string[],
    archived: boolean,
  ): Promise<SessionsState> {
    if (sessionIds.length === 0) {
      return state;
    }
    const batch: RemoteSessionBatch = archived
      ? await this.sessionsApi.archive(this.serverUrl(), this.token(), sessionIds)
      : await this.sessionsApi.unarchive(this.serverUrl(), this.token(), sessionIds);
    const devicesById: Map<string, AgentDevice> = state.devicesById();
    return state
      .withPatchedSessions(batch.sessions.map((dto: RemoteSession) => toAgentSession(dto, devicesById)))
      .withMissingSessionsRemoved(batch.notFound);
  }

  /**
   * Archives or unarchives every session on a device.
   *
   * Returns the updated count as well: the device page reports it in a toast, and
   * the Server's batch is the only place that number comes from.
   */
  async archiveAllForDevice(
    state: SessionsState,
    connectorId: string,
    archived: boolean,
    scope: string,
  ): Promise<DeviceArchiveAllResult> {
    const batch: RemoteSessionBatch = await this.sessionsApi.archiveAllForDevice(
      this.serverUrl(), this.token(), connectorId, archived, scope,
    );
    const devicesById: Map<string, AgentDevice> = state.devicesById();
    const sessions: AgentSession[] = batch.sessions.map(
      (dto: RemoteSession) => toAgentSession(dto, devicesById),
    );
    return {
      state: state.withPatchedSessions(sessions),
      updated: sessions.length,
    };
  }

  /**
   * Renames a device and applies the Server's row.
   *
   * Android's device rename lives in `DevicesController`; it is here because this
   * controller already owns the device list the rename has to patch.
   */
  async renameDevice(state: SessionsState, deviceId: string, name: string): Promise<SessionsState> {
    const device: AgentDevice = await this.devicesApi.rename(
      this.serverUrl(), this.token(), deviceId, name,
    );
    return state.withPatchedDevice(device);
  }

  /** Deletes a device and drops it from the list. */
  async deleteDevice(state: SessionsState, deviceId: string): Promise<SessionsState> {
    await this.devicesApi.delete(this.serverUrl(), this.token(), deviceId);
    return state.withDeletedDevice(deviceId);
  }

  /** Renames or pins a project, returning the authoritative row. */  async updateProject(
    state: SessionsState,
    projectId: string,
    name: string | null,
    pinned: boolean | null,
  ): Promise<SessionsState> {
    const project: AgentProject = await this.projectsApi.update(
      this.serverUrl(), this.token(), projectId, name, pinned,
    );
    return state.withPatchedProject(project);
  }

  /**
   * Archives every active session in a project.
   *
   * The Server returns the affected sessions, so the list is patched from that
   * response rather than refetching the whole dashboard.
   */
  async archiveProjectSessions(state: SessionsState, projectId: string): Promise<SessionsState> {
    const batch: RemoteSessionBatch = await this.sessionsApi.archiveAllForProject(
      this.serverUrl(), this.token(), projectId, true, 'active',
    );
    const devicesById: Map<string, AgentDevice> = state.devicesById();
    return state.withPatchedSessions(
      batch.sessions.map((dto: RemoteSession) => toAgentSession(dto, devicesById)),
    );
  }

  /**
   * Applies a dashboard snapshot.
   *
   * `devices` is passed separately because a snapshot may arrive before the
   * first HTTP device read has finished, and the names must not regress.
   */
  applyDashboard(state: SessionsState, snapshot: DashboardSnapshot): SessionsState {
    return state.replacedByDashboardSnapshot(snapshot, state.devices);
  }

  /**
   * Creates a session and sends its first message.
   *
   * Port of `SessionsController.createAndStartSession`. Three things happen
   * before the request: the workspace is resolved to a real path (a `~` root has
   * to be expanded by the Server), the project that owns that path is found or
   * created, and the draft is validated.
   *
   * A transport failure is special: the Server may have created the session
   * without the answer reaching us, so the list is re-read and searched for the
   * session the draft would have produced. One match means the create actually
   * succeeded; no match means it did not; anything else leaves the outcome
   * genuinely unknown, which the caller must not retry blindly.
   */
  async createAndStartSession(
    draft: NewSessionCreateDraft,
    devices: AgentDevice[],
    projects: AgentProject[] = [],
  ): Promise<NewSessionCreateOutcome> {
    const validation: string = validateNewSessionDraft(draft);
    if (validation.length > 0) {
      return NewSessionCreateOutcome.failed(validation);
    }
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    if (serverUrl.length === 0 || token.length === 0) {
      return NewSessionCreateOutcome.failed('Sign in again to create a session.');
    }

    let resolved: NewSessionCreateDraft;
    try {
      const path: string = await this.resolveDirectory(
        serverUrl, token, draft.connectorId, draft.cwd === null ? '' : draft.cwd,
      );
      let deviceOs: string | null = null;
      for (const device of devices) {
        if (device.id === draft.connectorId) {
          deviceOs = device.deviceOs;
          break;
        }
      }
      const project: AgentProject = await resolveWorkspaceProject(
        draft.connectorId,
        path,
        deviceOs,
        projects,
        async () => await this.projectsApi.list(serverUrl, token),
        async (name: string, workspacePath: string) =>
          await this.projectsApi.create(serverUrl, token, name, draft.connectorId, workspacePath, false),
      );
      resolved = new NewSessionCreateDraft(
        draft.connectorId, draft.runtime, draft.title, project.workspacePath, draft.content,
        draft.selections, draft.attachments, draft.clientMessageId, draft.knownSessionIds,
        draft.runtimeId, draft.runtimeType, project.id,
      );
    } catch (error) {
      return NewSessionCreateOutcome.failed(errorMessage(error, 'Could not resolve this workspace.'));
    }

    try {
      const attachments: RemoteInlineAttachmentRef[] = [];
      for (const part of resolved.attachments) {
        attachments.push(await toInlineAttachmentRef(part));
      }
      const request = new RemoteSessionCreateAndStartRequest(
        resolved.connectorId,
        resolved.projectId,
        resolved.runtimeType,
        resolved.title,
        resolved.cwd,
        resolved.content.trim(),
        resolved.selections.toMap(),
        attachments,
        resolved.clientMessageId,
        resolved.runtimeId,
        resolved.runtimeType,
      );
      const session: RemoteSession =
        await this.sessionsApi.createAndStartSession(serverUrl, token, request);
      return NewSessionCreateOutcome.created(
        toAgentSession(session, deviceMap(devices)),
      );
    } catch (error) {
      if (mayHaveUnknownCreateOutcome(error)) {
        return await this.reconcileCreateAfterNetworkFailure(resolved, serverUrl, token, error);
      }
      return NewSessionCreateOutcome.failed(errorMessage(error, 'Could not create and start this session.'));
    }
  }

  /**
   * Looks for the session a failed create may have made.
   *
   * Android re-reads both session pages and the project list, then asks
   * `newCreateCandidates` whether exactly one session matches the draft.
   */
  private async reconcileCreateAfterNetworkFailure(
    draft: NewSessionCreateDraft,
    serverUrl: string,
    token: string,
    originalError: Object,
  ): Promise<NewSessionCreateOutcome> {
    let refreshed: SessionsState | null = null;
    try {
      const active = await this.sessionsApi.list(serverUrl, token, false);
      const archived = await this.sessionsApi.list(serverUrl, token, true);
      const remoteDevices = await this.devicesApi.list(serverUrl, token);
      const remoteProjects = await this.projectsApi.list(serverUrl, token);
      const base: SessionsState = SessionsState.empty();
      const devicesById: Map<string, AgentDevice> = new Map();
      for (const device of remoteDevices) {
        devicesById.set(device.id, device);
      }
      const sessions: AgentSession[] = [];
      const archivedSessions: AgentSession[] = [];
      for (const session of active.sessions) {
        sessions.push(toAgentSession(session, devicesById));
      }
      for (const session of archived.sessions) {
        archivedSessions.push(toAgentSession(session, devicesById));
      }
      refreshed = base.copy({
        sessions: sessions,
        archivedSessions: archivedSessions,
        devices: remoteDevices,
        projects: remoteProjects,
        hasLoaded: true,
      });
    } catch (error) {
      AALog.warn(`Reconciling the create outcome failed: ${errorMessage(error, 'unknown')}`);
      refreshed = null;
    }

    const candidates: AgentSession[] = refreshed === null ? [] : newCreateCandidates(refreshed, draft);
    if (candidates.length === 1) {
      return NewSessionCreateOutcome.created(candidates[0], true, refreshed);
    }
    if (refreshed !== null && candidates.length === 0) {
      return NewSessionCreateOutcome.failed(
        errorMessage(originalError, 'Could not create and start this session.'), false, refreshed,
      );
    }
    return NewSessionCreateOutcome.failed(
      'The create request ended before its result could be confirmed. '
      + 'Return to Sessions and refresh before trying again.',
      true,
      refreshed,
    );
  }

  /**
   * Android's `loadProjects`: the workspace owners, straight from the Server.
   *
   * The new-project page re-reads them before it decides whether a directory
   * already belongs to a project, so another client's project is never silently
   * renamed.
   */
  async loadProjects(): Promise<AgentProject[]> {
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    if (serverUrl.length === 0 || token.length === 0) {
      throw new Error('Sign in again to load projects.');
    }
    return await this.projectsApi.list(serverUrl, token);
  }

  /**
   * Android's `createProject`: the directory is expanded first, so a project is
   * always stored against a real path, and `manuallyCreated` stays at its default
   * of `true` to mark this as a user-created project.
   */
  async createProject(
    name: string,
    connectorId: string,
    workspacePath: string,
  ): Promise<AgentProject> {
    const normalizedName: string = name.trim();
    const normalizedPath: string = workspacePath.trim();
    if (normalizedName.length === 0) {
      throw new Error('Project name is required.');
    }
    if (connectorId.trim().length === 0) {
      throw new Error('Connector is required.');
    }
    if (normalizedPath.length === 0) {
      throw new Error('Project path is required.');
    }
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    if (serverUrl.length === 0 || token.length === 0) {
      throw new Error('Sign in again to create a project.');
    }
    const resolved: string =
      await this.resolveDirectory(serverUrl, token, connectorId, normalizedPath);
    return await this.projectsApi.create(
      serverUrl, token, normalizedName, connectorId, resolved, true,
    );
  }

  /**
   * Expands a `~` workspace through the file listing, which is the only way the
   * client can learn the real home directory.
   */
  private async resolveDirectory(
    serverUrl: string,
    token: string,
    connectorId: string,
    path: string,
  ): Promise<string> {
    const clean: string = path.trim();
    if (!clean.startsWith('~')) {
      return clean;
    }
    const result: RemoteDirectory = await this.filesApi.listFiles(
      serverUrl, token, connectorId, clean, '.',
    );
    const resolved: string = result.path;
    const valid: boolean = resolved.trim().length > 0 && !resolved.startsWith('~')
      && result.targetType !== 'file';
    if (!valid) {
      throw new Error('Could not resolve the workspace directory.');
    }
    return resolved;
  }
}

/** The device lookup `toAgentSession` needs, keyed by connector id. */
function deviceMap(devices: AgentDevice[]): Map<string, AgentDevice> {
  const map: Map<string, AgentDevice> = new Map();
  for (const device of devices) {
    map.set(device.id, device);
  }
  return map;
}

function errorMessage(error: Object, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

/**
 * Whether a failed request may still have created the session.
 *
 * Android requires an `ApiException` without a status code whose cause chain
 * contains an `IOException`; a transport failure is exactly that case here, and
 * any error carrying a status code is a real answer from the Server.
 */
function mayHaveUnknownCreateOutcome(error: Object): boolean {
  if (!(error instanceof AAApiError)) {
    return false;
  }
  return error.statusCode === null;
}

/** The next state plus how many sessions the Server reported as updated. */
export interface DeviceArchiveAllResult {
  state: SessionsState;
  updated: number;
}

/** Builds the controller from the transport-level clients. */export function createSessionsController(  sessionsApi: SessionsApi,
  projectsApi: ProjectsApi,
  devicesApi: DevicesApi,
  filesApi: FilesApi,
  sessionStore: AuthSessionStore,
): SessionsController {
  return new SessionsController(sessionsApi, projectsApi, devicesApi, filesApi, sessionStore);
}
