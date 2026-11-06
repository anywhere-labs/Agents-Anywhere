import { TimelineAttachment } from './SessionTimelineProjection';
import { sha256, toHex } from '../../common/AAEncoding';

/**
 * Composer attachments.
 *
 * Port of `PendingAttachment` and `AttachmentUploadState` in
 * `ui/screens/sessiondetail/AttachmentImages.kt`, together with the limits from
 * `SessionDetailScreen.kt` (`MAX_ATTACHMENT_FILES`, `MAX_ATTACHMENT_BYTES`) and
 * `formatBytes` from the same file.
 *
 * One difference: Android keeps a `content://` Uri and re-reads it whenever the
 * bytes are needed, because the picker grant outlives the screen. HarmonyOS's
 * picker hands out a `file://` URI whose read grant is scoped to this process's
 * temporary permission as well, so the same "keep the URI, read at upload time"
 * shape is kept and the bytes are only ever held for the duration of one part.
 */

export enum AttachmentUploadState {
  Uploading = 0,
  Uploaded = 1,
  Failed = 2,
}

export interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** Local URI, used for the thumbnail and for reading the bytes to upload. */
  uri: string;
  uploadState: AttachmentUploadState;
  remote: TimelineAttachment | null;
  /**
   * Why the upload failed.
   *
   * Android stores the message on the item but never renders it — the strip only
   * swaps in a Retry pill — so it is kept here as the same kind of value (a
   * resource or a Server string) without being drawn.
   */
  errorMessage: ResourceStr | null;
}

/** Android's `MAX_ATTACHMENT_FILES`. */
export const MAX_ATTACHMENT_FILES: number = 6;
/** Android's `MAX_ATTACHMENT_BYTES`, which is also the download cap. */
export const MAX_ATTACHMENT_BYTES: number = 25 * 1024 * 1024;

export function isImageAttachment(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith('image/');
}

/** `1536 B`, `1.5 KB`, `2.0 MB`: one decimal, as Android's `formatBytes`. */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** A new pending attachment in Android's initial state: uploading. */
export function pendingAttachment(
  id: string,
  name: string,
  mediaType: string,
  size: number,
  uri: string,
): PendingAttachment {
  return {
    id: id,
    name: name,
    mediaType: mediaType,
    size: size,
    uri: uri,
    uploadState: AttachmentUploadState.Uploading,
    remote: null,
    errorMessage: null,
  };
}
/**
 * Replaces one attachment by id, keeping the list order.
 *
 * The Android helper is generic over the item list; only one list needs it here,
 * so it is written against `PendingAttachment` instead.
 */
export function updateAttachment(
  attachments: PendingAttachment[],
  id: string,
  transform: (attachment: PendingAttachment) => PendingAttachment,
): PendingAttachment[] {
  const next: PendingAttachment[] = [];
  for (const attachment of attachments) {
    next.push(attachment.id === id ? transform(attachment) : attachment);
  }
  return next;
}

/** True when every attachment finished uploading, which gates sending. */
export function attachmentsReady(attachments: PendingAttachment[]): boolean {
  for (const attachment of attachments) {
    if (attachment.uploadState !== AttachmentUploadState.Uploaded) {
      return false;
    }
  }
  return true;
}

/** The file ids to send with the message, in list order. */
export function uploadedAttachmentIds(attachments: PendingAttachment[]): string[] {
  const ids: string[] = [];
  for (const attachment of attachments) {
    const remote: TimelineAttachment | null = attachment.remote;
    if (attachment.uploadState === AttachmentUploadState.Uploaded && remote !== null) {
      ids.push(remote.fileId);
    }
  }
  return ids;
}

/**
 * The timeline row a draft attachment gets without an upload.
 *
 * Port of `UploadFilePart.toLocalTimelineAttachment`: a prepared session has no
 * Server session to upload against, so the row is built from the bytes the client
 * already holds — the SHA-256 of those bytes becomes the file id, so the size,
 * name and type the composer shows are the real ones and nothing waits on the
 * Server having seen the file. The bytes themselves travel with the first message
 * as an inline part.
 */
export async function localDraftAttachment(
  name: string,
  mediaType: string,
  size: number,
  bytes: ArrayBuffer,
): Promise<TimelineAttachment> {
  const digest: string = toHex(await sha256(new Uint8Array(bytes)));
  return {
    fileId: digest,
    name: name,
    mediaType: mediaType,
    size: size,
  };
}
