import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { AALog } from './AAAppLog';

/**
 * Decodes image bytes into a `PixelMap`.
 *
 * The remote image loader hands in the downloaded bytes; `createImageSource`
 * accepts a buffer directly, so no file is written. Returns `null` for anything
 * that is not a decodable image, which the UI turns into its fallback tile.
 */
export async function decodeImageBytes(
  bytes: ArrayBuffer,
  targetSize: number,
): Promise<image.PixelMap | null> {
  if (bytes.byteLength === 0) {
    return null;
  }
  let source: image.ImageSource | null = null;
  try {
    source = image.createImageSource(bytes);
    const options: image.DecodingOptions = {
      desiredSize: { width: targetSize, height: targetSize },
    };
    return await source.createPixelMap(options);
  } catch (error) {
    AALog.warn(`Image decode failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  } finally {
    if (source !== null) {
      try {
        await source.release();
      } catch (error) {
        AALog.debug('Releasing an image source failed');
      }
    }
  }
}

/**
 * Local image loading.
 *
 * ArkUI's `Image` component cannot decode a picker URI on its own, so a
 * thumbnail is produced by opening the file and asking ImageKit for a
 * downscaled `PixelMap`. The decode happens once per URI and is dropped when the
 * component goes away, so a strip of six attachments holds at most six small
 * bitmaps.
 */
export async function loadLocalThumbnail(uri: string, targetSize: number): Promise<image.PixelMap | null> {
  let file: fileIo.File | null = null;
  let source: image.ImageSource | null = null;
  try {
    file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    source = image.createImageSource(file.fd);
    const options: image.DecodingOptions = {
      desiredSize: { width: targetSize, height: targetSize },
    };
    return await source.createPixelMap(options);
  } catch (error) {
    AALog.warn(`Thumbnail failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  } finally {
    if (source !== null) {
      try {
        await source.release();
      } catch (error) {
        AALog.debug('Releasing an image source failed');
      }
    }
    if (file !== null) {
      try {
        fileIo.closeSync(file);
      } catch (error) {
        AALog.debug('Closing a thumbnail file failed');
      }
    }
  }
}
