import { AgentSession } from '../../model/AgentSession';
import { SessionsState } from './SessionsState';
import { NewSessionSelections } from './NewSessionRuntimeSelectionState';
import { RemoteInlineAttachmentRef } from '../../api/SessionsApi';
import { isValidRuntimeInstanceId, isValidRuntimeType } from '../../api/RuntimeIdentity';
import { base64Encode, sha256, toHex } from '../../common/AAEncoding';

/**
 * New-session draft values and submission bookkeeping.
 *
 * Port of `feature/sessions/NewSessionState.kt`.
 *
 * The create call is the one request in the client that may have already
 * succeeded when the connection drops, so the submission state carries two
 * flags: `inFlight` and `outcomeUnknown`. Once the outcome is unknown the page
 * refuses to start another attempt, and the app instead re-reads the session
 * list and looks for a session matching the draft (`newCreateCandidates`).
 */

/** One workspace suggestion. */
export class NewSessionWorkspace {
  readonly title: string;
  readonly path: string;
  readonly detail: string;
  readonly home: boolean;

  constructor(title: string, path: string, detail: string, home: boolean = false) {
    this.title = title;
    this.path = path;
    this.detail = detail;
    this.home = home;
  }
}

/** One entry of the directory browser. */
export class NewSessionPathEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number | null;

  constructor(name: string, path: string, isDirectory: boolean, size: number | null) {
    this.name = name;
    this.path = path;
    this.isDirectory = isDirectory;
    this.size = size;
  }
}

export class NewSessionDirectory {
  readonly path: string;
  readonly entries: NewSessionPathEntry[];

  constructor(path: string, entries: NewSessionPathEntry[]) {
    this.path = path;
    this.entries = entries;
  }
}

export class NewSessionAttachmentPart {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;

  constructor(name: string, mediaType: string, bytes: Uint8Array) {
    this.name = name;
    this.mediaType = mediaType;
    this.bytes = bytes;
  }
}

/** Everything the create request needs. */
export class NewSessionCreateDraft {
  readonly connectorId: string;
  readonly runtime: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly content: string;
  readonly selections: NewSessionSelections;
  readonly attachments: NewSessionAttachmentPart[];
  readonly clientMessageId: string;
  readonly knownSessionIds: Set<string>;
  readonly runtimeId: string;
  readonly runtimeType: string;
  readonly projectId: string;

  constructor(
    connectorId: string,
    runtime: string,
    title: string | null,
    cwd: string | null,
    content: string,
    selections: NewSessionSelections,
    attachments: NewSessionAttachmentPart[],
    clientMessageId: string,
    knownSessionIds: Set<string>,
    runtimeId: string = runtime,
    runtimeType: string = runtime,
    projectId: string = '',
  ) {
    this.connectorId = connectorId;
    this.runtime = runtime;
    this.title = title;
    this.cwd = cwd;
    this.content = content;
    this.selections = selections;
    this.attachments = attachments;
    this.clientMessageId = clientMessageId;
    this.knownSessionIds = knownSessionIds;
    this.runtimeId = runtimeId;
    this.runtimeType = runtimeType;
    this.projectId = projectId;
  }
}

/**
 * Raised when a create request failed without telling us whether it landed.
 *
 * The app answers it by refreshing the session list and looking for the
 * session the draft would have produced.
 */
export class AANewSessionCreateResultUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AANewSessionCreateResultUnknownError';
  }
}

export class NewSessionSubmissionStart {
  readonly state: NewSessionSubmissionState;
  readonly clientMessageId: string;

  constructor(state: NewSessionSubmissionState, clientMessageId: string) {
    this.state = state;
    this.clientMessageId = clientMessageId;
  }
}

/**
 * Whether a create is running, and what we know about it.
 *
 * `clientMessageId` is kept across a retry so the Server can recognise the same
 * attempt instead of creating a second session.
 */
export class NewSessionSubmissionState {
  readonly inFlight: boolean;
  readonly clientMessageId: string | null;
  readonly outcomeUnknown: boolean;
  readonly errorMessage: string | null;

  constructor(
    inFlight: boolean = false,
    clientMessageId: string | null = null,
    outcomeUnknown: boolean = false,
    errorMessage: string | null = null,
  ) {
    this.inFlight = inFlight;
    this.clientMessageId = clientMessageId;
    this.outcomeUnknown = outcomeUnknown;
    this.errorMessage = errorMessage;
  }

  /** Starts a submission, or `null` when one is already running or unresolved. */
  begin(newClientMessageId: () => string): NewSessionSubmissionStart | null {
    if (this.inFlight || this.outcomeUnknown) {
      return null;
    }
    const existing: string | null = this.clientMessageId;
    const messageId: string = existing !== null && existing.trim().length > 0
      ? existing : newClientMessageId();
    return new NewSessionSubmissionStart(
      new NewSessionSubmissionState(true, messageId, false, null),
      messageId,
    );
  }

  fail(message: string, outcomeUnknown: boolean): NewSessionSubmissionState {
    return new NewSessionSubmissionState(false, this.clientMessageId, outcomeUnknown, message);
  }

  /** The page was left or torn down while the request was in flight. */
  interrupted(message: string): NewSessionSubmissionState {
    if (!this.inFlight) {
      return this;
    }
    return this.fail(message, true);
  }
}

/**
 * Sessions that may be the one a create request just made.
 *
 * The id is unknown after an interrupted create, so the match is by connector,
 * project, runtime and workspace, with the title compared only when the draft
 * asked for one. Sessions the client already knew about are excluded, which is
 * what makes an empty answer meaningful.
 */
export function newCreateCandidates(
  state: SessionsState,
  draft: NewSessionCreateDraft,
): AgentSession[] {
  const expectedTitle: string = draft.title === null ? '' : draft.title.trim();
  const expectedCwd: string = draft.cwd === null ? '' : draft.cwd.trim();
  const candidates: AgentSession[] = [];
  for (const session of state.sessions.concat(state.archivedSessions)) {
    if (draft.knownSessionIds.has(session.id)) {
      continue;
    }
    if (session.connectorId !== draft.connectorId) {
      continue;
    }
    if ((session.projectId ?? '') !== draft.projectId) {
      continue;
    }
    if (session.runtimeId !== draft.runtimeId || session.runtimeType !== draft.runtimeType) {
      continue;
    }
    if (expectedTitle.length > 0 && session.title !== expectedTitle) {
      continue;
    }
    const cwd: string = session.cwd === null ? '' : session.cwd.trim();
    if (cwd !== expectedCwd) {
      continue;
    }
    candidates.push(session);
  }
  return candidates;
}

/**
 * The workspace choices for a device: the home directory, then every directory a
 * session has already used on it.
 */export function workspaceOptionsFor(
  sessions: AgentSession[],
  deviceId: string | null,
  homePath: string | null,
): NewSessionWorkspace[] {
  const home: string = homePath !== null && homePath.trim().length > 0 ? homePath : '~';
  const seen: string[] = [];
  const existing: NewSessionWorkspace[] = [];
  for (const session of sessions) {
    if (deviceId !== null && session.connectorId !== deviceId) {
      continue;
    }
    if (session.cwd === null) {
      continue;
    }
    const trimmed: string = session.cwd.trim().replace(/\/+$/, '');
    if (trimmed.length === 0 || trimmed === home || seen.includes(trimmed)) {
      continue;
    }
    seen.push(trimmed);
    existing.push(new NewSessionWorkspace(
      workspaceTitle(trimmed, homePath),
      trimmed,
      workspaceDisplayPath(trimmed, homePath),
    ));
  }
  // Android's `sortedBy { title.lowercase() }` is stable, so equal titles keep
  // the order the sessions were read in.
  existing.sort((left: NewSessionWorkspace, right: NewSessionWorkspace) => {
    return left.title.toLowerCase().localeCompare(right.title.toLowerCase());
  });
  const options: NewSessionWorkspace[] = [
    new NewSessionWorkspace('Home directory', home, workspaceDisplayPath(home, homePath), true),
  ];
  return options.concat(existing);
}

/** The label a workspace path gets in the picker. */
export function workspaceTitle(path: string, homePath: string | null): string {
  const home: string = homePath === null ? '' : homePath.replace(/\/+$/, '');
  const clean: string = path.replace(/\/+$/, '');
  if (home.trim().length > 0 && clean === home) {
    return 'Home directory';
  }
  const afterSlash: string = clean.substring(clean.lastIndexOf('/') + 1);
  return afterSlash.trim().length > 0 ? afterSlash : path;
}

/**
 * The path with the home directory abbreviated to `~`.
 *
 * Note the Android quirk this keeps: a path that only *equals* `/` (so it never
 * starts with `"$home/"`) is printed as given, not abbreviated.
 */
export function workspaceDisplayPath(path: string, homePath: string | null): string {
  const home: string = homePath === null ? '' : homePath.replace(/\/+$/, '');
  if (home.trim().length === 0) {
    return path;
  }
  const clean: string = path.replace(/\/+$/, '');
  if (clean === home) {
    return home;
  }
  if (!clean.startsWith(`${home}/`)) {
    return path;
  }
  return `~/${clean.substring(home.length + 1)}`;
}

// --------------------------------------------------------------- creation

/** Android's cap on files sent with the first message. */
export const MAX_CREATE_ATTACHMENTS: number = 10;
/** Android's cap on one inline attachment: 25 MiB. */
export const MAX_CREATE_ATTACHMENT_BYTES: number = 25 * 1024 * 1024;

/**
 * Checks a draft before it is sent.
 *
 * Port of `SessionsController.validateNewSessionDraft`: the return value is the
 * message to show, or an empty string when the draft is sendable. The order of
 * the checks is the order the user would fix them in.
 */
export function validateNewSessionDraft(draft: NewSessionCreateDraft): string {
  if (draft.connectorId.trim().length === 0) {
    return 'Choose a connector before starting.';
  }
  if (draft.cwd === null || draft.cwd.trim().length === 0) {
    return 'Choose a workspace before starting.';
  }
  if (!isValidRuntimeType(draft.runtimeType) || draft.runtime !== draft.runtimeType) {
    return 'Choose a valid runtime type before starting.';
  }
  if (!isValidRuntimeInstanceId(draft.runtimeId, draft.runtimeType)) {
    return 'Choose a valid runtime instance before starting.';
  }
  if (draft.content.trim().length === 0 && draft.attachments.length === 0) {
    return 'Enter a message or attach a file before starting.';
  }
  if (draft.clientMessageId.trim().length === 0) {
    return 'The client message ID is missing.';
  }
  if (draft.attachments.length > MAX_CREATE_ATTACHMENTS) {
    return `You can attach up to ${MAX_CREATE_ATTACHMENTS} files.`;
  }
  for (const attachment of draft.attachments) {
    if (attachment.name.trim().length === 0) {
      return 'An attachment name is missing.';
    }
  }
  for (const attachment of draft.attachments) {
    if (attachment.bytes.length === 0) {
      return 'Attachments cannot be empty.';
    }
  }
  for (const attachment of draft.attachments) {
    if (attachment.bytes.length > MAX_CREATE_ATTACHMENT_BYTES) {
      return `Attachment ${attachment.name} is too large.`;
    }
  }
  return '';
}

/**
 * Turns a draft attachment into the inline reference the Server expects.
 *
 * Android derives the file id from the SHA-256 digest, and sends the bytes
 * base64-encoded in the same request so the first message needs no upload step.
 */
export async function toInlineAttachmentRef(
  attachment: NewSessionAttachmentPart,
): Promise<RemoteInlineAttachmentRef> {
  const digest: Uint8Array = await sha256(attachment.bytes);
  const hex: string = toHex(digest);
  const mediaType: string = attachment.mediaType.trim().length > 0
    ? attachment.mediaType : 'application/octet-stream';
  return new RemoteInlineAttachmentRef(
    hex,
    attachment.name,
    mediaType,
    attachment.bytes.length,
    hex,
    base64Encode(attachment.bytes),
  );
}

/** Whether a create attempt ended with the session made, or not. */
export enum NewSessionCreateOutcomeKind {
  Created = 0,
  Failed = 1,
}

/**
 * The result of a create attempt.
 *
 * `outcomeUnknown` is the important flag: the request reached the Server but its
 * answer never arrived, so the app must not simply retry — it re-reads the
 * session list and looks for the session the draft would have produced
 * (`newCreateCandidates`).
 */
export class NewSessionCreateOutcome {
  readonly kind: NewSessionCreateOutcomeKind;
  readonly session: AgentSession | null;
  readonly recoveredAfterNetworkFailure: boolean;
  readonly refreshedState: SessionsState | null;
  readonly errorMessage: string;
  readonly outcomeUnknown: boolean;

  constructor(
    kind: NewSessionCreateOutcomeKind,
    session: AgentSession | null,
    recoveredAfterNetworkFailure: boolean,
    refreshedState: SessionsState | null,
    errorMessage: string,
    outcomeUnknown: boolean,
  ) {
    this.kind = kind;
    this.session = session;
    this.recoveredAfterNetworkFailure = recoveredAfterNetworkFailure;
    this.refreshedState = refreshedState;
    this.errorMessage = errorMessage;
    this.outcomeUnknown = outcomeUnknown;
  }

  static created(
    session: AgentSession,
    recoveredAfterNetworkFailure: boolean = false,
    refreshedState: SessionsState | null = null,
  ): NewSessionCreateOutcome {
    return new NewSessionCreateOutcome(
      NewSessionCreateOutcomeKind.Created, session, recoveredAfterNetworkFailure,
      refreshedState, '', false,
    );
  }

  static failed(
    message: string,
    outcomeUnknown: boolean = false,
    refreshedState: SessionsState | null = null,
  ): NewSessionCreateOutcome {
    return new NewSessionCreateOutcome(
      NewSessionCreateOutcomeKind.Failed, null, false, refreshedState, message, outcomeUnknown,
    );
  }

  succeeded(): boolean {
    return this.kind === NewSessionCreateOutcomeKind.Created;
  }
}
