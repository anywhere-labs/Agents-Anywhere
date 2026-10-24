import type { ImageAttachmentLimits, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { BridgeError } from './errors.js'

const NATIVE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const satisfies readonly ImageMediaType[]
const CONVERTED_IMAGE_TYPES = ['image/avif', 'image/tiff'] as const
export const IMAGE_MIME_TYPES = [...NATIVE_IMAGE_TYPES, ...CONVERTED_IMAGE_TYPES] as const
type ImageInputType = typeof IMAGE_MIME_TYPES[number]

export function isImageInputType(mediaType: string): mediaType is ImageInputType {
  return IMAGE_MIME_TYPES.some(type => type === mediaType)
}

/** Convert additional raster formats before official DSH image admission. Native images pass through. */
export async function prepareImage(data: Buffer, mediaType: ImageInputType, limits: ImageAttachmentLimits,
  signal: AbortSignal): Promise<{ data: Buffer, mediaType: ImageMediaType }> {
  signal.throwIfAborted()
  if (mediaType !== 'image/avif' && mediaType !== 'image/tiff') return { data, mediaType }
  if (!limits.mediaTypes.includes('image/png')) {
    throw new BridgeError('INVALID_PARAMS', 'AVIF and TIFF conversion requires PNG to be accepted by this DSH deployment.')
  }
  const { default: sharp } = await import('sharp')
  try {
    const image = sharp(data, { failOn: 'warning', limitInputPixels: limits.maxImagePixels })
    const metadata = await image.metadata()
    signal.throwIfAborted()
    const expectedFormat = mediaType === 'image/tiff' ? 'tiff' : 'heif'
    if (metadata.format !== expectedFormat || (mediaType === 'image/avif' && metadata.compression !== 'av1')) {
      throw new BridgeError('INVALID_PARAMS', 'Image contents do not match the attachment media type.')
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new BridgeError('INVALID_PARAMS', 'Multi-page TIFF and animated AVIF images are not supported. Send a single image or convert each page separately.')
    }
    if (Math.max(metadata.width, metadata.height) > limits.maxImageDimension ||
        metadata.width * metadata.height > limits.maxImagePixels) {
      throw new BridgeError('INVALID_PARAMS', 'Image exceeds the DSH attachment pixel or dimension limits.')
    }
    // Apply EXIF orientation and strip metadata; DSH still validates and stores the resulting PNG.
    const converted = await image.autoOrient().toColourspace('srgb').png().toBuffer()
    signal.throwIfAborted()
    if (converted.length > limits.maxImageBytes) {
      throw new BridgeError('INVALID_PARAMS', 'Converted image exceeds the DSH attachment byte limit. Resize the image and retry.')
    }
    return { data: converted, mediaType: 'image/png' }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof BridgeError) throw error
    // Native decoder diagnostics may contain private metadata; only expose an actionable summary.
    throw new BridgeError('INVALID_PARAMS', 'Unable to decode this AVIF or TIFF image within the DSH limits. Convert it to PNG or JPEG and retry.')
  }
}
