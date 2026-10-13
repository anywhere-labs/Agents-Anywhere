import { AAPreferenceNames, AAPreferenceStore } from '../../storage/AAPreferences';
import { AALog } from '../../common/AAAppLog';
import { AttachmentUploadState, PendingAttachment } from './PendingAttachment';
import { TimelineAttachment } from './SessionTimelineProjection';

/**
 * Composer drafts.
 *
 * Port of `ui/screens/sessiondetail/SessionComposerDraftStore.kt`.
 *
 * What the user typed — and what they attached — survives leaving the
 * conversation and restarting the app. The store keeps an in-memory map for the
 * session, and mirrors it into a per-account preferences file whose name is
 * Android's (`session-composer-drafts-<userId hash>`), keyed by session id.
 *
 * Two fields of Android's document are deliberately not written: `clientMessageId`
 * and `retryAction` only exist for the optimistic-retry flow, which this port does
 * not have (see the plan's deviation table). A draft written here is therefore a
 * subset of Android's, and decoding tolerates every missing field the same way.
 *
 * Android also cannot keep an upload alive across a process death: an attachment
 * still in the `Uploading` state is restored as failed, with the message the
 * caller supplies.
 */

/** One saved composer state. */
export class ComposerDraft {
  readonly text: string;
  readonly attachments: PendingAttachment[];

  constructor(text: string, attachments: PendingAttachment[]) {
    this.text = text;
    this.attachments = attachments;
  }

  static empty(): ComposerDraft {
    return new ComposerDraft('', []);
  }

  /** Android's "nothing worth keeping" test. */
  isEmpty(): boolean {
    return this.text.trim().length === 0 && this.attachments.length === 0;
  }
}

/** The wire shape of one stored attachment; every field is optional on read. */
interface StoredAttachmentDto {
  uri?: string;
  name?: string;
  mediaType?: string;
  size?: number;
  id?: string;
  uploadState?: string;
  errorMessage?: string;
  remote?: StoredRemoteDto;
}

interface StoredRemoteDto {
  fileId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
}

interface StoredDraftDto {
  text?: string;
  attachments?: StoredAttachmentDto[];
}

/** Android's `encodeDraft`. */
export function encodeComposerDraft(draft: ComposerDraft): string {
  const attachments: StoredAttachmentDto[] = [];
  for (const attachment of draft.attachments) {
    const stored: StoredAttachmentDto = {
      uri: attachment.uri,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      id: attachment.id,
      uploadState: uploadStateName(attachment.uploadState),
    };
    const message: ResourceStr | null = attachment.errorMessage;
    if (typeof message === 'string' && message.length > 0) {
      stored.errorMessage = message;
    }
    const remote: TimelineAttachment | null = attachment.remote;
    if (remote !== null) {
      stored.remote = {
        fileId: remote.fileId,
        name: remote.name,
        mediaType: remote.mediaType,
        size: remote.size,
      };
    }
    attachments.push(stored);
  }
  return JSON.stringify({ text: draft.text, attachments: attachments } as StoredDraftDto);
}

/**
 * Android's `decodeDraft`, which returns `null` rather than throwing.
 *
 * The state name is matched against the three known values; anything else — a
 * newer client's value, or a truncated write — restores as failed, which is
 * Android's `getOrDefault(AttachmentUploadState.Failed)`.
 */
export function decodeComposerDraft(raw: string): ComposerDraft | null {
  if (raw.length === 0) {
    return null;
  }
  let parsed: StoredDraftDto;
  try {
    parsed = JSON.parse(raw) as StoredDraftDto;
  } catch (error) {
    AALog.debug('Discarding an unreadable composer draft');
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const attachments: PendingAttachment[] = [];
  const stored: StoredAttachmentDto[] = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  for (const entry of stored) {
    let remote: TimelineAttachment | null = null;
    const storedRemote: StoredRemoteDto | undefined = entry.remote;
    if (storedRemote !== undefined && typeof storedRemote.fileId === 'string') {
      remote = {
        fileId: storedRemote.fileId,
        name: typeof storedRemote.name === 'string' ? storedRemote.name : storedRemote.fileId,
        mediaType: typeof storedRemote.mediaType === 'string' ? storedRemote.mediaType : '',
        size: typeof storedRemote.size === 'number' ? storedRemote.size : 0,
      };
    }
    const message: string = typeof entry.errorMessage === 'string' ? entry.errorMessage : '';
    attachments.push({
      uri: typeof entry.uri === 'string' ? entry.uri : '',
      name: typeof entry.name === 'string' ? entry.name : 'attachment',
      mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : '',
      size: typeof entry.size === 'number' ? entry.size : 0,
      id: typeof entry.id === 'string' ? entry.id : '',
      uploadState: uploadStateFromName(
        typeof entry.uploadState === 'string' ? entry.uploadState : '',
      ),
      remote: remote,
      errorMessage: message.length > 0 ? message : null,
    });
  }
  return new ComposerDraft(typeof parsed.text === 'string' ? parsed.text : '', attachments);
}

/**
 * Marks every attachment that was still uploading as failed.
 *
 * An upload cannot survive the process, so a restored `Uploading` row would sit
 * there forever; Android rewrites it and re-saves. The message is a resource and
 * is deliberately not persisted — it is re-applied on each restore.
 */
export function normalizeRestoredDraft(
  draft: ComposerDraft,
  uploadCancelledMessage: ResourceStr,
): ComposerDraft {
  const attachments: PendingAttachment[] = [];
  for (const attachment of draft.attachments) {
    if (attachment.uploadState !== AttachmentUploadState.Uploading) {
      attachments.push(attachment);
      continue;
    }
    attachments.push({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      uri: attachment.uri,
      uploadState: AttachmentUploadState.Failed,
      remote: attachment.remote,
      errorMessage: attachment.errorMessage ?? uploadCancelledMessage,
    });
  }
  return new ComposerDraft(draft.text, attachments);
}

function uploadStateName(state: AttachmentUploadState): string {
  if (state === AttachmentUploadState.Uploaded) {
    return 'Uploaded';
  }
  if (state === AttachmentUploadState.Failed) {
    return 'Failed';
  }
  return 'Uploading';
}

function uploadStateFromName(name: string): AttachmentUploadState {
  if (name === 'Uploaded') {
    return AttachmentUploadState.Uploaded;
  }
  if (name === 'Uploading') {
    return AttachmentUploadState.Uploading;
  }
  return AttachmentUploadState.Failed;
}

export class ComposerDraftStore {
  private readonly store: AAPreferenceStore;
  private readonly memory: Map<string, ComposerDraft> = new Map<string, ComposerDraft>();

  constructor(userId: string) {
    this.store = new AAPreferenceStore(AAPreferenceNames.composerDrafts(userId));
  }

  /** The stored draft, with in-flight uploads rewritten to failed. */
  restore(sessionId: string, uploadCancelledMessage: ResourceStr): ComposerDraft {
    if (sessionId.length === 0) {
      return ComposerDraft.empty();
    }
    let draft: ComposerDraft | undefined = this.memory.get(sessionId);
    if (draft === undefined) {
      const raw: string = this.store.getString(sessionId, '');
      const decoded: ComposerDraft | null = decodeComposerDraft(raw);
      if (decoded === null) {
        return ComposerDraft.empty();
      }
      draft = decoded;
    }
    const normalized: ComposerDraft = normalizeRestoredDraft(draft, uploadCancelledMessage);
    this.save(sessionId, normalized.text, normalized.attachments);
    return normalized;
  }

  /** Stores a draft, or clears it when there is nothing left to keep. */
  save(sessionId: string, text: string, attachments: PendingAttachment[]): void {
    if (sessionId.length === 0) {
      return;
    }
    const draft: ComposerDraft = new ComposerDraft(text, attachments);
    if (draft.isEmpty()) {
      this.clear(sessionId);
      return;
    }
    this.memory.set(sessionId, draft);
    this.store.setString(sessionId, encodeComposerDraft(draft));
  }

  clear(sessionId: string): void {
    if (sessionId.length === 0) {
      return;
    }
    this.memory.delete(sessionId);
    this.store.delete(sessionId);
  }
}
