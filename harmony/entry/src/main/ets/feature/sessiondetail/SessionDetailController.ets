import { AgentDevice, AgentSession } from '../../model/AgentSession';
import { SessionsApi, RemoteSessionShareResponse } from '../../api/SessionsApi';
import { RemoteSession, RemoteSessionEnvelope } from '../../api/SessionsDtos';
import { RemoteSessionSnapshot, RemoteSessionTimelinePage } from '../../api/TimelineDtos';
import {
  isCapabilityUsable, noticeBlocksSession, RemoteRpcResponse, RemoteRuntimeNotice,
  RemoteSessionRuntimeState, SessionCapability,
} from '../../api/RuntimeDtos';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import {
  RuntimeModelCatalog, RuntimePermissionCatalog,
} from '../../api/RuntimeCatalogDtos';
import { RuntimeSettingsState } from './RuntimeSettingsState';
import { RuntimeCommand, toRuntimeCommand } from './RuntimeCommandsState';
import { RemoteSessionCommand } from '../../api/RuntimeDtos';
import { ParsedSelectionsPatch, RemoteUploadedAttachment } from '../../api/SessionsApi';
import { UploadFilePart } from '../../api/HttpTransport';
import { verifyUploadedAttachments } from './SessionAttachmentTransfer';
import { toAgentSession } from '../sessions/SessionMappers';
import { SessionDetailState } from './SessionDetailState';
import {
  groupTimeline, mergeTimelineMessages, projectTimeline, TimelineAttachment, TimelineMessage,
  TimelineRenderItem,
} from './SessionTimelineProjection';
import { AALog } from '../../common/AAAppLog';
import { randomUuid } from '../../common/AAEncoding';

/**
 * Session detail workflows.
 *
 * Port of `feature/sessiondetail/SessionDetailController.kt`.
 *
 * The controller owns the ordering of one session: load a snapshot, page older
 * history, send or steer a message, interrupt, and flip takeover. It returns the
 * next state and never touches UI.
 *
 * Two Android behaviours are reproduced deliberately:
 *
 *  - the message action is chosen from the capability set *and* the live status,
 *    because a runtime may support steering while a turn runs yet require a plain
 *    send when idle;
 *  - a failed action is reported as a thrown error so the screen can keep the
 *    draft, rather than being silently swallowed.
 */

/** Which verb a send resolves to. */
export enum MessageAction {
  Send = 0,
  Steer = 1,
}

/** Cursor page size, matching Android's `INITIAL_TIMELINE_LIMIT`. */
const TIMELINE_PAGE_LIMIT: number = 100;

export class SessionDetailController {
  private readonly sessionsApi: SessionsApi;
  private readonly sessionStore: AuthSessionStore;

  constructor(sessionsApi: SessionsApi, sessionStore: AuthSessionStore) {
    this.sessionsApi = sessionsApi;
    this.sessionStore = sessionStore;
  }

  private serverUrl(): string {
    return this.sessionStore.readServerUrl();
  }

  private token(): string {
    return this.sessionStore.readAccessToken();
  }

  /**
   * Loads the snapshot that makes the screen usable.
   *
   * Devices are passed in because the session row's device name is resolved
   * during mapping and the dashboard already holds the list.
   */
  async load(devices: AgentDevice[], sessionId: string): Promise<SessionDetailState> {
    let next: SessionDetailState = SessionDetailState.empty().copy({
      loading: true,
      errorMessage: null,
    });
    try {
      const snapshot: RemoteSessionSnapshot = await this.sessionsApi.snapshot(
        this.serverUrl(), this.token(), sessionId, TIMELINE_PAGE_LIMIT,
      );
      next = this.applySnapshot(next, snapshot, devices);
      return next.copy({ loading: false, initialized: true, errorMessage: null });
    } catch (error) {
      const message: string = error instanceof Error ? error.message : 'Could not load messages.';
      AALog.warn(`Session snapshot failed for ${sessionId}: ${message}`);
      return next.copy({ loading: false, errorMessage: message });
    }
  }

  /** Applies a snapshot (initial load or a refetch after a realtime hint). */
  applySnapshot(
    state: SessionDetailState,
    snapshot: RemoteSessionSnapshot,
    devices: AgentDevice[],
  ): SessionDetailState {
    const timeline: TimelineMessage[] = projectTimeline(snapshot.timeline.items);
    const notices: RemoteRuntimeNotice[] = snapshot.notices;
    const runtimeState: RemoteSessionRuntimeState | null = snapshot.state;
    return state.copy({
      session: snapshot.session,
      timeline: timeline,
      renderItems: this.group(timeline, notices),
      notices: notices,
      capabilities: snapshot.effectiveCapabilities,
      runtimeStatus: this.statusFromSnapshot(snapshot),
      eventCursor: snapshot.eventCursor,
      hasMore: snapshot.timeline.hasMore,
      oldestOrderSeq: minOrderSeq(timeline),
      latestOrderSeq: maxOrderSeq(timeline),
      // The snapshot is authoritative, so the staleness guards restart from it.
      noticesEventSequence: 0,
      runtimeUpdatedSeq: runtimeState === null ? 0 : runtimeState.updatedSeq,
      runtimeLoaded: runtimeState !== null,
    });
  }

  /**
   * Uploads attachment parts and verifies what the Server stored.
   *
   * Android's `SessionAttachmentTransfer.upload`: the response is matched
   * positionally with the parts and every byte count and SHA-256 is compared, so
   * a truncated or corrupted upload never becomes a message attachment.
   */
  async uploadAttachments(
    sessionId: string,
    parts: UploadFilePart[],
  ): Promise<TimelineAttachment[]> {
    const uploaded: RemoteUploadedAttachment[] = await this.sessionsApi.uploadSessionAttachments(
      this.serverUrl(), this.token(), sessionId, parts,
    );
    return await verifyUploadedAttachments(uploaded, parts);
  }

  /** Downloads an attachment's bytes for display or for a save. */
  async loadAttachmentBytes(sessionId: string, fileId: string): Promise<ArrayBuffer> {
    return await this.sessionsApi.downloadAttachmentBytes(
      this.serverUrl(), this.token(), sessionId, fileId,
    );
  }

  /** Pages older history using the oldest loaded `orderSeq` as the cursor. */  async loadOlder(state: SessionDetailState): Promise<SessionDetailState> {
    const sessionId: string = state.sessionId();
    if (sessionId.length === 0 || !state.hasMore || state.loadingOlder) {
      return state;
    }
    let next: SessionDetailState = state.copy({ loadingOlder: true });
    try {
      const page: RemoteSessionTimelinePage = await this.sessionsApi.timelineHistory(
        this.serverUrl(), this.token(), sessionId, state.oldestOrderSeq, TIMELINE_PAGE_LIMIT,
      );
      const older: TimelineMessage[] = projectTimeline(page.items);
      const merged: TimelineMessage[] = mergeTimelineMessages(older, state.timeline);
      // `orderSeq <= 1` is the floor; below it there is nothing left to load.
      const nextOldest: number = minOrderSeq(merged);
      return next.copy({
        timeline: merged,
        renderItems: this.group(merged, state.notices),
        hasMore: page.hasMore && nextOldest > 1,
        oldestOrderSeq: nextOldest,
        latestOrderSeq: maxOrderSeq(merged),
        loadingOlder: false,
      });
    } catch (error) {
      AALog.warn(`Older timeline page failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return next.copy({ loadingOlder: false });
    }
  }

  /**
   * Chooses between send and steer.
   *
   * Steering is preferred while a turn is active when the runtime supports it;
   * otherwise a plain send is used. When neither is usable the caller is told so
   * instead of the message disappearing.
   */
  messageAction(state: SessionDetailState): MessageAction | null {
    const session: RemoteSession | null = state.session;
    if (session === null) {
      return null;
    }
    const canSend: boolean = isCapabilityUsable(
      state.capabilities, SessionCapability.SEND_MESSAGE, session.runtimeId, session.runtimeType,
    );
    const canSteer: boolean = isCapabilityUsable(
      state.capabilities, SessionCapability.STEER, session.runtimeId, session.runtimeType,
    );
    if (canSteer && (!canSend || state.isTurnActive())) {
      return MessageAction.Steer;
    }
    if (canSend) {
      return MessageAction.Send;
    }
    if (canSteer) {
      return MessageAction.Steer;
    }
    return null;
  }

  /**
   * Sends or steers a message.
   *
   * The Server's `ok` flag decides success: an absent flag parses to false, so a
   * malformed response cannot be mistaken for an accepted message.
   */
  async submitMessage(
    state: SessionDetailState,
    content: string,
    clientMessageId: string,
    attachmentFileIds: string[],
  ): Promise<SessionDetailState> {
    const sessionId: string = state.sessionId();
    const action: MessageAction | null = this.messageAction(state);
    if (sessionId.length === 0) {
      throw new Error('Open a session before sending.');
    }
    if (action === null) {
      throw new Error('The runtime cannot accept another instruction right now.');
    }
    let next: SessionDetailState = state.copy({ sending: true, errorMessage: null });
    try {
      const response: RemoteRpcResponse = action === MessageAction.Steer
        ? await this.sessionsApi.steer(
          this.serverUrl(), this.token(), sessionId, content, clientMessageId, attachmentFileIds,
        )
        : await this.sessionsApi.sendMessage(
          this.serverUrl(), this.token(), sessionId, content, clientMessageId, attachmentFileIds,
        );
      if (!response.ok) {
        throw new Error(response.errorMessage ?? 'Failed to send message.');
      }
      return next.copy({ sending: false });
    } catch (error) {
      const message: string = error instanceof Error ? error.message : 'Failed to send message.';
      throw new Error(message);
    }
  }

  /** Interrupts the running turn. */
  async interrupt(state: SessionDetailState): Promise<SessionDetailState> {
    const sessionId: string = state.sessionId();
    if (sessionId.length === 0) {
      return state;
    }
    let next: SessionDetailState = state.copy({ interrupting: true });
    try {
      const response: RemoteRpcResponse = await this.sessionsApi.interrupt(
        this.serverUrl(), this.token(), sessionId,
      );
      if (!response.ok) {
        throw new Error(response.errorMessage ?? 'Could not interrupt this session.');
      }
      return next.copy({ interrupting: false });
    } catch (error) {
      next = next.copy({ interrupting: false });
      throw new Error(error instanceof Error ? error.message : 'Could not interrupt this session.');
    }
  }

  /** Turns takeover on or off and returns the authoritative session. */
  async setTakeover(state: SessionDetailState, enabled: boolean): Promise<SessionDetailState> {
    const sessionId: string = state.sessionId();
    if (sessionId.length === 0) {
      return state;
    }
    let next: SessionDetailState = state.copy({ takeoverBusy: true });
    try {
      const envelope: RemoteSessionEnvelope = await this.sessionsApi.setTakeover(
        this.serverUrl(), this.token(), sessionId, enabled,
      );
      return next.copy({ session: envelope.session, takeoverBusy: false });
    } catch (error) {
      next = next.copy({ takeoverBusy: false });
      throw new Error(error instanceof Error ? error.message : 'Could not update takeover.');
    }
  }

  /** Responds to an approval or input request. */
  async respondToNotice(
    state: SessionDetailState,
    noticeId: string,
    actionId: string,
    input: Object | null = null,
  ): Promise<SessionDetailState> {
    const sessionId: string = state.sessionId();
    if (sessionId.length === 0) {
      return state;
    }
    const response: RemoteRpcResponse = await this.sessionsApi.respondToNotice(
      this.serverUrl(), this.token(), sessionId, noticeId, actionId, input,
    );
    if (!response.ok) {
      // A notice the Server no longer has resolves the same way for the user.
      if (isNoticeGone(response.errorCode)) {
        return this.withoutNotice(state, noticeId);
      }
      throw new Error(response.errorMessage ?? 'Could not send the runtime response.');
    }
    return this.withoutNotice(state, noticeId);
  }

  /** Marks the session read; a failure is not worth interrupting the user. */
  async markRead(sessionId: string): Promise<boolean> {
    try {
      const batch = await this.sessionsApi.markRead(this.serverUrl(), this.token(), [sessionId]);
      return batch.sessions.some((session: RemoteSession) => session.id === sessionId);
    } catch (error) {
      AALog.debug(`Mark read failed for ${sessionId}`);
      return false;
    }
  }

  /**
   * Loads both live catalogs for the settings sheet.
   *
   * They are fetched together because the sheet shows the model list and the
   * permission mode on two pages of one surface; a partial load would render
   * one page empty.
   */
  async loadCatalogs(
    settings: RuntimeSettingsState,
    sessionId: string,
    runtimeId: string | null,
  ): Promise<RuntimeSettingsState> {
    if (sessionId.length === 0) {
      return settings;
    }
    let next: RuntimeSettingsState = settings.copy({
      modelLoading: true,
      permissionLoading: true,
      modelError: null,
      permissionError: null,
      error: '',
    });
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();

    try {
      const catalog: RuntimeModelCatalog = await this.sessionsApi.runtimeModelCatalog(
        serverUrl, token, sessionId, runtimeId,
      );
      next = next.copy({
        modelCatalog: catalog,
        modelRevision: catalog.revision,
        modelLoading: false,
        loaded: true,
        stale: false,
      });
    } catch (error) {
      const message: string = error instanceof Error
        ? error.message
        : 'Could not load the live model catalog.';
      // An already-loaded catalog stays visible and is marked stale.
      next = next.copy({
        modelLoading: false,
        modelError: message,
        stale: next.modelCatalog !== null,
      });
    }

    try {
      const catalog: RuntimePermissionCatalog = await this.sessionsApi.runtimePermissionCatalog(
        serverUrl, token, sessionId, runtimeId,
      );
      next = next.copy({
        permissionCatalog: catalog,
        permissionRevision: catalog.revision,
        permissionLoading: false,
        loaded: true,
      });
    } catch (error) {
      const message: string = error instanceof Error
        ? error.message
        : 'Could not load the live permission catalog.';
      next = next.copy({
        permissionLoading: false,
        permissionError: message,
        stale: next.permissionCatalog !== null || next.stale,
      });
    }

    return next;
  }

  /**
   * Applies a selection change.
   *
   * The whole map is patched, and the Server's echo is applied only when it
   * reports success, so the sheet never shows a selection the runtime rejected.
   */
  async patchSelection(
    settings: RuntimeSettingsState,
    sessionId: string,
    scope: string,
    selectionId: string | null,
    runtimeId: string | null,
  ): Promise<RuntimeSettingsState> {
    if (sessionId.length === 0) {
      return settings;
    }
    let next: RuntimeSettingsState = settings.copy({ busy: true, error: '' });
    try {
      const result: ParsedSelectionsPatch = await this.sessionsApi.patchSelections(
        this.serverUrl(), this.token(), sessionId, settings.withSelection(scope, selectionId),
      );
      if (!result.ok) {
        throw new Error('Could not update the runtime selection.');
      }
      const applied: Map<string, string | null> = result.state === null
        ? settings.withSelection(scope, selectionId)
        : result.state.selections;
      return next.copy({ selections: applied, busy: false });
    } catch (error) {
      const message: string = error instanceof Error
        ? error.message
        : 'Could not update the runtime selection.';
      return next.copy({ busy: false, error: message });
    }
  }

  /**
   * Android's `loadCommands`: the session's slash-command catalog.
   *
   * The panel maps the wire rows through `toRuntimeCommand`, which is where the
   * defaults for a missing field live.
   */
  async loadCommands(sessionId: string): Promise<RuntimeCommand[]> {
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    if (serverUrl.length === 0 || token.length === 0) {
      throw new Error('Sign in again to load commands.');
    }
    const commands: RemoteSessionCommand[] =
      await this.sessionsApi.runtimeCommands(serverUrl, token, sessionId);
    const mapped: RuntimeCommand[] = [];
    for (const command of commands) {
      mapped.push(toRuntimeCommand(command));
    }
    return mapped;
  }

  /**
   * Android's `executeCommand`: runs a slash command and refuses a rejection.
   *
   * The Server answers with the same `{ ok, error }` envelope as the other
   * runtime RPCs, so a `false` flag becomes a thrown message rather than a silent
   * success.
   */
  async executeCommand(
    sessionId: string,
    command: string,
    args: string[],
    raw: string,
  ): Promise<void> {
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    if (serverUrl.length === 0 || token.length === 0) {
      throw new Error('Sign in again to run this command.');
    }
    const response: RemoteRpcResponse = await this.sessionsApi.executeCommand(
      serverUrl, token, sessionId, command, args, raw,
    );
    if (!response.ok) {
      throw new Error(response.errorMessage ?? response.errorCode ?? 'Command failed.');
    }
  }

  /**
   * Android's `createShare`: mints a share link for a scope.
   *
   * `scope` is the Server's own vocabulary (`message` or `session`); for a
   * `message` share `itemIds` names the messages the link covers, and the Server
   * rejects an empty list.
   */
  async createShare(
    sessionId: string,
    scope: string,
    itemIds: string[],
  ): Promise<RemoteSessionShareResponse> {
    const serverUrl: string = this.serverUrl();
    const token: string = this.token();
    if (serverUrl.length === 0 || token.length === 0) {
      throw new Error('Sign in again to share this session.');
    }
    return await this.sessionsApi.createSessionShare(serverUrl, token, sessionId, scope, itemIds);
  }

  newClientMessageId(): string {
    return `opt_${randomUuid()}`;
  }

  /** Notices that block the session until answered. */
  blockingNotices(state: SessionDetailState): RemoteRuntimeNotice[] {
    const sessionId: string = state.sessionId();
    const blocking: RemoteRuntimeNotice[] = [];
    for (const notice of state.openNotices()) {
      if (noticeBlocksSession(notice, sessionId)) {
        blocking.push(notice);
      }
    }
    return blocking;
  }

  /**
   * Open notices that belong in the conversation rather than above the composer.
   *
   * A notice attached to a timeline item is drawn inside that item, so only the
   * unattached ones become standalone rows.
   */
  detachedNotices(state: SessionDetailState): RemoteRuntimeNotice[] {
    const detached: RemoteRuntimeNotice[] = [];
    for (const notice of state.openNotices()) {
      if (noticeTargetIds(notice).length === 0) {
        detached.push(notice);
      }
    }
    return detached;
  }

  private withoutNotice(state: SessionDetailState, noticeId: string): SessionDetailState {
    const notices: RemoteRuntimeNotice[] = state.notices.filter(
      (notice: RemoteRuntimeNotice) => notice.noticeId !== noticeId,
    );
    return state.copy({
      notices: notices,
      renderItems: this.group(state.timeline, notices),
    });
  }

  /** Regroups with the currently open notices, which suppress collapsing. */
  private group(timeline: TimelineMessage[], notices: RemoteRuntimeNotice[]): TimelineRenderItem[] {
    const targets: string[] = [];
    for (const notice of notices) {
      if (notice.status !== 'open') {
        continue;
      }
      const targets_inner: string[] = noticeTargetIds(notice);
      for (const id of targets_inner) {
        targets.push(id);
      }
    }
    return groupTimeline(timeline, targets);
  }

  private statusFromSnapshot(snapshot: RemoteSessionSnapshot): string {
    // The snapshot's runtime state is optional; the session's own status is the
    // fallback so the composer still has something to reason about.
    const state: RemoteSessionRuntimeState | null = snapshot.state;
    return state === null ? snapshot.session.status : state.status;
  }
}

/**
 * Timeline item ids an open notice points at.
 *
 * Exported because the screen needs the same rule to decide which row a notice
 * belongs to, and two copies of it would drift.
 */
export function noticeTargetIds(notice: RemoteRuntimeNotice): string[] {
  const ids: string[] = [];
  const context: Record<string, Object> = notice.context as Record<string, Object>;
  const source: Record<string, Object> = notice.source as Record<string, Object>;
  for (const map of [context, source]) {
    const value: Object = map['timelineItemId'];
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value);
    }
    const itemId: Object = map['itemId'];
    if (typeof itemId === 'string' && itemId.length > 0) {
      ids.push(itemId);
    }
  }
  return ids;
}

/** Error codes that mean the notice is already resolved. */
function isNoticeGone(code: string | null): boolean {
  if (code === null) {
    return false;
  }
  return code === 'not_found'
    || code === 'notice_not_found'
    || code === 'interaction_not_found'
    || code === 'request_not_found'
    || code === 'approval_not_found';
}

/**
 * Merges older history ahead of the current timeline.
 *
 * Items are deduped by id keeping the higher revision, and the result is ordered
 * by `orderSeq` then `updatedSeq` then id, which is Android's ordering.
 */
function minOrderSeq(messages: TimelineMessage[]): number {
  if (messages.length === 0) {
    return 0;
  }
  let min: number = messages[0].orderSeq;
  for (const message of messages) {
    if (message.orderSeq < min) {
      min = message.orderSeq;
    }
  }
  return min;
}

function maxOrderSeq(messages: TimelineMessage[]): number {
  let max: number = 0;
  for (const message of messages) {
    if (message.orderSeq > max) {
      max = message.orderSeq;
    }
  }
  return max;
}

/** Convenience for callers that need an `AgentSession` rather than the wire row. */
export function sessionFromWire(session: RemoteSession, devices: AgentDevice[]): AgentSession {
  const byId: Map<string, AgentDevice> = new Map();
  for (const device of devices) {
    byId.set(device.id, device);
  }
  return toAgentSession(session, byId);
}
