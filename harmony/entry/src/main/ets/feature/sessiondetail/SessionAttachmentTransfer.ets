import { UploadFilePart } from '../../api/HttpTransport';
import { RemoteUploadedAttachment } from '../../api/SessionsApi';
import { sha256, toHex } from '../../common/AAEncoding';
import { TimelineAttachment } from './SessionTimelineProjection';

/**
 * Attachment upload verification.
 *
 * Port of `feature/sessiondetail/SessionAttachmentTransfer.kt`, minus the
 * download half, which arrives with the attachment viewer.
 *
 * The Server is never trusted about what it stored: the byte count and the
 * SHA-256 of every uploaded part are compared with the local bytes, and a
 * mismatch rejects the whole batch. That is Android's behaviour, including the
 * detail that a missing `sha256` in the response counts as a mismatch.
 */

export enum AttachmentTransferFailure {
  InvalidBase64 = 0,
  IncompleteUpload = 1,
  SizeMismatch = 2,
  Sha256Mismatch = 3,
}

export class AttachmentTransferException extends Error {
  readonly failure: AttachmentTransferFailure;
  readonly attachmentName: string | null;

  constructor(failure: AttachmentTransferFailure, attachmentName: string | null) {
    super(attachmentName === null ? `${failure}` : `${failure}: ${attachmentName}`);
    this.failure = failure;
    this.attachmentName = attachmentName;
  }
}

/**
 * Verifies the Server's echo of an upload and converts it to timeline attachments.
 *
 * The parts and the response are matched positionally, which is what the Server's
 * ordering guarantees, so a response with a different count is rejected outright.
 */
export async function verifyUploadedAttachments(
  uploaded: RemoteUploadedAttachment[],
  local: UploadFilePart[],
): Promise<TimelineAttachment[]> {
  if (uploaded.length !== local.length) {
    throw new AttachmentTransferException(AttachmentTransferFailure.IncompleteUpload, null);
  }
  const verified: TimelineAttachment[] = [];
  for (let index = 0; index < uploaded.length; index++) {
    const remote: RemoteUploadedAttachment = uploaded[index];
    const part: UploadFilePart = local[index];
    const localSha256: string = toHex(await sha256(new Uint8Array(part.bytes)));
    if (remote.size !== part.bytes.byteLength) {
      throw new AttachmentTransferException(AttachmentTransferFailure.SizeMismatch, part.name);
    }
    const remoteSha256: string = remote.sha256 === null ? '' : remote.sha256.toLowerCase();
    if (remoteSha256 !== localSha256) {
      throw new AttachmentTransferException(AttachmentTransferFailure.Sha256Mismatch, part.name);
    }
    verified.push({
      fileId: remote.fileId,
      name: remote.name,
      mediaType: remote.mediaType,
      size: remote.size,
    });
  }
  return verified;
}

/** `^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$`, with the empty type allowed. */
const ATTACHMENT_MEDIA_TYPE_PATTERN: RegExp = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export function isValidAttachmentMediaType(mediaType: string): boolean {
  return mediaType.length === 0 || ATTACHMENT_MEDIA_TYPE_PATTERN.test(mediaType.toLowerCase());
}

/**
 * The message for a transfer failure.
 *
 * Android resolves these through `attachmentErrorMessage`, falling back to the
 * caller's string; the resource is returned rather than resolved so the
 * attachment name can be interpolated by the resource itself.
 */
export function attachmentErrorMessage(error: Object, fallback: ResourceStr): ResourceStr {
  if (!(error instanceof AttachmentTransferException)) {
    return fallback;
  }
  const transfer: AttachmentTransferException = error as AttachmentTransferException;
  const name: string = transfer.attachmentName ?? '';
  const named: ResourceStr = name.length > 0 ? name : $r('app.string.session_attachment_name_fallback');
  if (transfer.failure === AttachmentTransferFailure.InvalidBase64) {
    return $r('app.string.session_attachment_base64_invalid');
  }
  if (transfer.failure === AttachmentTransferFailure.IncompleteUpload) {
    return $r('app.string.session_attachment_upload_incomplete');
  }
  if (transfer.failure === AttachmentTransferFailure.SizeMismatch) {
    return $r('app.string.session_attachment_size_mismatch', named);
  }
  if (transfer.failure === AttachmentTransferFailure.Sha256Mismatch) {
    return $r('app.string.session_attachment_sha_mismatch', named);
  }
  return fallback;
}
