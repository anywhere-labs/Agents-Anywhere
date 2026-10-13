import { AgentSession, SessionStatus } from '../../model/AgentSession';
import { randomUuid } from '../../common/AAEncoding';
import {
  NewSessionAttachmentPart, NewSessionCreateDraft,
} from './NewSessionState';
import { NewSessionSelections } from './NewSessionRuntimeSelectionState';

/**
 * A locally prepared session.
 *
 * Port of `feature/sessions/NewSessionDraft.kt`.
 *
 * The Server session and its runtime thread are created only when the user sends
 * the first real message from the conversation screen, so the page can open a
 * conversation immediately, showing the workspace and runtime the user chose,
 * without a round trip. That is why the draft carries a synthetic "local" id:
 * the conversation screen recognises it and turns the first send into a create.
 */

export class NewSessionDraft {
  /** Prefix of the synthetic session id a draft preview uses. */
  static readonly LOCAL_NEW_SESSION_ID: string = 'local:new-session';

  readonly connectorId: string;
  readonly runtime: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly deviceName: string;
  readonly runtimeLabel: string;
  readonly knownSessionIds: Set<string>;
  readonly selections: NewSessionSelections;
  readonly runtimeId: string;
  readonly runtimeType: string;
  readonly runtimeName: string;
  readonly attachmentsEnabled: boolean;
  readonly localSessionId: string;
  readonly projectId: string;

  constructor(
    connectorId: string,
    runtime: string,
    title: string | null,
    cwd: string | null,
    deviceName: string,
    runtimeLabel: string,
    knownSessionIds: Set<string>,
    selections: NewSessionSelections = new NewSessionSelections(),
    runtimeId: string = runtime,
    runtimeType: string = runtime,
    runtimeName: string = runtimeLabel,
    attachmentsEnabled: boolean = true,
    localSessionId: string = NewSessionDraft.newLocalSessionId(),
    projectId: string = '',
  ) {
    this.connectorId = connectorId;
    this.runtime = runtime;
    this.title = title;
    this.cwd = cwd;
    this.deviceName = deviceName;
    this.runtimeLabel = runtimeLabel;
    this.knownSessionIds = knownSessionIds;
    this.selections = selections;
    this.runtimeId = runtimeId;
    this.runtimeType = runtimeType;
    this.runtimeName = runtimeName;
    this.attachmentsEnabled = attachmentsEnabled;
    this.localSessionId = localSessionId;
    this.projectId = projectId;
  }

  static newLocalSessionId(): string {
    return `${NewSessionDraft.LOCAL_NEW_SESSION_ID}:${randomUuid()}`;
  }

  /** True when a session id belongs to a draft rather than to the Server. */
  static isLocalSessionId(sessionId: string): boolean {
    return sessionId.startsWith(`${NewSessionDraft.LOCAL_NEW_SESSION_ID}:`);
  }

  /**
   * The session the conversation screen shows before anything exists on the
   * Server: idle, live and online, with no messages and no timestamps.
   */
  previewSession(): AgentSession {
    return {
      id: this.localSessionId,
      connectorId: this.connectorId,
      projectId: this.projectId.length > 0 ? this.projectId : null,
      deviceName: this.deviceName,
      title: this.title ?? '',
      summary: '',
      cwd: this.cwd,
      workspaceLabel: this.cwd ?? '',
      runtime: this.runtimeType,
      runtimeLabel: this.runtimeLabel,
      status: SessionStatus.Idle,
      statusLabel: '',
      updatedAtLabel: '',
      metaLabel: '',
      pinned: false,
      archived: false,
      unread: false,
      lastReadSeq: 0,
      takeover: true,
      connectorOnline: true,
      live: true,
      sortKey: '',
      updatedSeq: 0,
      runtimeId: this.runtimeId,
      runtimeType: this.runtimeType,
      runtimeName: this.runtimeName,
      archivedAt: null,
      optimisticTopUntil: 0,
      sortAt: null,
    };
  }
}

/** The create request the first message of a draft turns into. */
export function firstMessageRequest(
  draft: NewSessionDraft,
  content: string,
  selections: NewSessionSelections,
  attachments: NewSessionAttachmentPart[],
  clientMessageId: string,
): NewSessionCreateDraft {
  return new NewSessionCreateDraft(
    draft.connectorId,
    draft.runtimeType,
    draft.title,
    draft.cwd,
    content.trim(),
    selections,
    attachments,
    clientMessageId,
    draft.knownSessionIds,
    draft.runtimeId,
    draft.runtimeType,
    draft.projectId,
  );
}
