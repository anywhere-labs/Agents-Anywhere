import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';

// Mirrors the Android client's avatar pipeline (ProfileSettingsSupport.kt):
// the picked image is scaled so its longest edge is at most 256px, re-encoded
// as a lossless PNG and uploaded as a `data:image/png;base64,...` URL. The
// server caps the stored avatar payload at 256KB (auth.py AVATAR_MAX_LENGTH).
const AVATAR_MAX_EDGE = 256;

async function readUriBytes(uri: string): Promise<Uint8Array> {
  const file = await fileIo.open(uri, fileIo.OpenMode.READ_ONLY);
  try {
    const stat = await fileIo.stat(file.fd);
    const arrayBuffer = new ArrayBuffer(stat.size);
    await fileIo.read(file.fd, arrayBuffer);
    return new Uint8Array(arrayBuffer);
  } finally {
    await fileIo.close(file.fd);
  }
}

/**
 * Turn a photo-picker URI into the avatar data URL the server expects
 * (`data:image/png;base64,...`). Throws when the image cannot be decoded.
 */
export async function avatarDataUrlFromUri(uri: string): Promise<string> {
  const bytes = await readUriBytes(uri);
  const source = image.createImageSource(bytes);
  let pixelMap: image.PixelMap | null = null;
  try {
    pixelMap = await source.createPixelMap();
    const info = await source.getImageInfo();
    const longestEdge = Math.max(info.size.width, info.size.height);
    if (longestEdge > AVATAR_MAX_EDGE) {
      const scale = AVATAR_MAX_EDGE / longestEdge;
      await pixelMap.scale(scale, scale);
    }
    const packer = image.createImagePacker();
    let packed: ArrayBuffer;
    try {
      packed = await packer.packToData(pixelMap, { format: 'image/png', quality: 100 });
    } finally {
      packer.release();
    }
    const base64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(packed));
    return `data:image/png;base64,${base64}`;
  } finally {
    if (pixelMap !== null) {
      pixelMap.release();
    }
    await source.release();
  }
}
