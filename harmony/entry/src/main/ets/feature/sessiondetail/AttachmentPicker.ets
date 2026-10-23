import { fileIo } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { common } from '@kit.AbilityKit';
import { AALog } from '../../common/AAAppLog';

/**
 * Attachment picking and reading.
 *
 * Android uses the photo picker (`PickMultipleVisualMedia`), the document picker
 * (`OpenMultipleDocuments`) and an in-app camera. HarmonyOS exposes the same two
 * system pickers, and the photo picker can be asked to offer a capture entry
 * (`isPhotoTakingSupported`), which stands in for the camera screen until the
 * camera pass lands; that substitution is recorded in the port plan.
 *
 * Two deliberate differences from Android:
 *
 *  - the media type is derived from the file extension, because there is no
 *    `ContentResolver.getType` equivalent for a picked URI, and
 *  - the file is measured from its stat rather than from a cursor, because
 *    Android's metadata query has no counterpart either.
 *
 * Both are heuristics on the same inputs the user chose, and the server-side
 * media-type validation still runs before an upload is accepted.
 */

/** One file the user picked, before it becomes a composer attachment. */
export interface PickedAttachment {
  uri: string;
  name: string;
  mediaType: string;
  size: number;
}

const MEDIA_TYPES: Map<string, string> = new Map<string, string>([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'],
  ['heic', 'image/heic'], ['heif', 'image/heif'], ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'], ['txt', 'text/plain'], ['md', 'text/markdown'],
  ['json', 'application/json'], ['xml', 'application/xml'], ['yaml', 'text/yaml'],
  ['yml', 'text/yaml'], ['csv', 'text/csv'], ['html', 'text/html'],
  ['htm', 'text/html'], ['log', 'text/plain'], ['zip', 'application/zip'],
  ['gz', 'application/gzip'], ['tar', 'application/x-tar'], ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'], ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'], ['doc', 'application/msword'], ['docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'], ['xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt', 'application/vnd.ms-powerpoint'], ['pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

/** The last path segment of a URI, with any query string removed. */
export function fileNameFromUri(uri: string): string {
  let path: string = uri;
  const query: number = path.indexOf('?');
  if (query >= 0) {
    path = path.substring(0, query);
  }
  const slash: number = path.lastIndexOf('/');
  const name: string = slash >= 0 ? path.substring(slash + 1) : path;
  if (name.length === 0) {
    return 'attachment';
  }
  try {
    return decodeURIComponent(name);
  } catch (error) {
    return name;
  }
}

/** The media type for a file name, or `application/octet-stream` when unknown. */
export function mediaTypeForFileName(name: string): string {
  const dot: number = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return 'application/octet-stream';
  }
  const extension: string = name.substring(dot + 1).toLowerCase();
  return MEDIA_TYPES.get(extension) ?? 'application/octet-stream';
}

/**
 * Measures a picked file.
 *
 * The size comes from the file's stat so the per-file limit is applied before
 * anything is read into memory.
 */
export function describePickedFile(uri: string): PickedAttachment | null {
  let file: fileIo.File | null = null;
  try {
    file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    const stat: fileIo.Stat = fileIo.statSync(file.fd);
    const name: string = fileNameFromUri(uri);
    return {
      uri: uri,
      name: name,
      mediaType: mediaTypeForFileName(name),
      size: stat.size,
    };
  } catch (error) {
    AALog.warn(`Could not read picked file: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  } finally {
    if (file !== null) {
      try {
        fileIo.closeSync(file);
      } catch (error) {
        AALog.debug('Closing a picked file failed');
      }
    }
  }
}

/** Reads a picked file's bytes; throws when it cannot be read or is empty. */
export function readAttachmentBytes(uri: string, name: string): ArrayBuffer {
  let file: fileIo.File | null = null;
  try {
    file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    const stat: fileIo.Stat = fileIo.statSync(file.fd);
    if (stat.size <= 0) {
      throw new Error(`The file ${name} is empty.`);
    }
    const buffer: ArrayBuffer = new ArrayBuffer(stat.size);
    const read: number = fileIo.readSync(file.fd, buffer);
    return read === stat.size ? buffer : buffer.slice(0, read);
  } catch (error) {
    // Rethrown so the caller can mark the attachment failed with a message
    // that names the file; the `finally` below still closes the descriptor.
    throw error instanceof Error
      ? error
      : new Error(`The file ${name} could not be read.`);
  } finally {
    if (file !== null) {
      try {
        fileIo.closeSync(file);
      } catch (error) {
        AALog.debug('Closing a picked file failed');
      }
    }
  }
}

/**
 * Wraps the two system pickers.
 *
 * The context is the ability context the pickers want; when it is unavailable
 * the parameterless constructors are used, which the SDK still supports.
 */
export class AttachmentPicker {
  private readonly context: common.Context | undefined;

  constructor(context: common.Context | undefined) {
    this.context = context;
  }

  /** Photo picker; `allowCapture` adds the camera entry to the system sheet. */
  async pickImages(max: number, allowCapture: boolean): Promise<PickedAttachment[]> {
    try {
      const options = new photoAccessHelper.PhotoSelectOptions();
      options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      options.maxSelectNumber = max;
      options.isPhotoTakingSupported = allowCapture;
      // The photo picker takes no context; only the document picker offers the
      // context constructor.
      const instance: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
      const result: photoAccessHelper.PhotoSelectResult = await instance.select(options);
      return this.describeAll(result.photoUris);
    } catch (error) {
      AALog.warn(`Photo picker failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return [];
    }
  }

  /** Document picker, the equivalent of Android's `OpenMultipleDocuments`. */
  async pickFiles(max: number): Promise<PickedAttachment[]> {
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = max;
      const instance: picker.DocumentViewPicker = this.context === undefined
        ? new picker.DocumentViewPicker()
        : new picker.DocumentViewPicker(this.context);
      const uris: string[] = await instance.select(options);
      return this.describeAll(uris);
    } catch (error) {
      AALog.warn(`File picker failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return [];
    }
  }

  private describeAll(uris: string[]): PickedAttachment[] {
    const picked: PickedAttachment[] = [];
    for (const uri of uris) {
      const described: PickedAttachment | null = describePickedFile(uri);
      if (described !== null) {
        picked.push(described);
      }
    }
    return picked;
  }

  /**
   * Writes bytes to a location the user picks.
   *
   * Android saves attachments into the gallery through MediaStore. HarmonyOS has
   * no unprivileged gallery write, so the document picker's save mode is used
   * instead: the user chooses the destination and the file is written there,
   * which keeps every save visible to the user rather than buried in the sandbox.
   */
  async saveFileAs(name: string, bytes: ArrayBuffer): Promise<boolean> {
    let target: string = '';
    try {
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [name.length > 0 ? name : 'attachment'];
      const instance: picker.DocumentViewPicker = this.context === undefined
        ? new picker.DocumentViewPicker()
        : new picker.DocumentViewPicker(this.context);
      const uris: string[] = await instance.save(options);
      if (uris.length === 0) {
        return false;
      }
      target = uris[0];
    } catch (error) {
      AALog.warn(`Save dialog failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    }

    let file: fileIo.File | null = null;
    try {
      file = fileIo.openSync(target, fileIo.OpenMode.READ_WRITE);
      fileIo.writeSync(file.fd, bytes);
      return true;
    } catch (error) {
      AALog.warn(`Writing the saved file failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    } finally {
      if (file !== null) {
        try {
          fileIo.closeSync(file);
        } catch (error) {
          AALog.debug('Closing a saved file failed');
        }
      }
    }
  }
}
