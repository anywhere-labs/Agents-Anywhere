import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { SharedApiClient } from '../api/SharedApiClient';
import { AuthSessionStore } from '../auth/AuthSessionStore';
import { errorMessageFrom } from 'common';
import { RemoteDownloadedAttachment } from 'network';
import { SessionsApi } from 'network';
import { getColors } from 'common';

const ATTACHMENT_IMAGE_CACHE_LIMIT = 32;
const ATTACHMENT_MAX_DOWNLOAD_BYTES = 26214400;
const ATTACHMENT_PENDING_POLL_MS = 600;

const attachmentPixelMapCache: Map<string, image.PixelMap> = new Map();
const attachmentPixelMapOrder: string[] = [];
const attachmentPendingKeys: Set<string> = new Set();

function rememberAttachmentPixelMap(key: string, pixelMap: image.PixelMap): void {
  if (attachmentPixelMapCache.has(key)) {
    return;
  }
  attachmentPixelMapCache.set(key, pixelMap);
  attachmentPixelMapOrder.push(key);
  while (attachmentPixelMapOrder.length > ATTACHMENT_IMAGE_CACHE_LIMIT) {
    const evicted = attachmentPixelMapOrder.shift();
    if (evicted === undefined) {
      break;
    }
    const cached = attachmentPixelMapCache.get(evicted);
    if (cached !== undefined) {
      cached.release();
    }
    attachmentPixelMapCache.delete(evicted);
  }
}

function attachmentPendingDelay(): Promise<void> {
  return new Promise<void>((resolve: (value: void) => void) => {
    setTimeout((): void => {
      resolve();
    }, ATTACHMENT_PENDING_POLL_MS);
  });
}

export async function loadAttachmentPixelMap(sessionId: string, fileId: string): Promise<image.PixelMap> {
  const key = `${sessionId}/${fileId}`;
  const cached = attachmentPixelMapCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  if (attachmentPendingKeys.has(key)) {
    await attachmentPendingDelay();
    return loadAttachmentPixelMap(sessionId, fileId);
  }
  attachmentPendingKeys.add(key);
  try {
    const authStore = AuthSessionStore.getInstance();
    const sessionsApi = new SessionsApi(SharedApiClient.getInstance());
    const downloaded: RemoteDownloadedAttachment = await sessionsApi.downloadSessionAttachment(
      authStore.readServerUrl(), authStore.readAccessToken(), sessionId, fileId);
    if (downloaded.contentBase64.length === 0) {
      throw new Error('The attachment did not download completely.');
    }
    const decoder = new util.Base64Helper();
    const bytes = decoder.decodeSync(downloaded.contentBase64);
    if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_MAX_DOWNLOAD_BYTES) {
      throw new Error('The attachment is too large to display.');
    }
    if (downloaded.size > 0 && bytes.byteLength !== downloaded.size) {
      throw new Error('The attachment did not download completely.');
    }
    const source = image.createImageSource(bytes);
    const decoded = await source.createPixelMap();
    await source.release();
    rememberAttachmentPixelMap(key, decoded);
    return decoded;
  } finally {
    attachmentPendingKeys.delete(key);
  }
}

@Component
export struct AttachmentImageView {
  @Prop sessionId: string = '';
  @Prop fileId: string = '';
  @State pixelMap: image.PixelMap | undefined = undefined;
  @State loadState: string = 'loading';
  @State errorText: string = '';

  aboutToAppear(): void {
    this.loadPixelMap();
  }

  private async loadPixelMap(): Promise<void> {
    if (this.fileId.length === 0 || this.sessionId.length === 0) {
      this.loadState = 'failed';
      this.errorText = 'Attachment is unavailable.';
      return;
    }
    try {
      this.pixelMap = await loadAttachmentPixelMap(this.sessionId, this.fileId);
      this.loadState = 'loaded';
    } catch (error) {
      this.loadState = 'failed';
      this.errorText = errorMessageFrom(error as Object);
    }
  }

  private statusLabel(): string {
    if (this.loadState === 'loading') {
      return 'Loading image…';
    }
    return this.errorText.length > 0 ? this.errorText : 'Could not load the attachment.';
  }

  build() {
    Column() {
      if (this.pixelMap !== undefined) {
        Image(this.pixelMap)
          .objectFit(ImageFit.Cover)
          .borderRadius(14)
          .width(196)
          .height(142)
      } else if (this.loadState === 'failed') {
        Row({ space: 8 }) {
          Text(this.statusLabel())
            .fontSize(12)
            .fontColor(getColors().muted)
            .layoutWeight(1)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Button('Retry')
            .fontSize(11)
            .height(24)
            .padding({ left: 8, right: 8 })
            .backgroundColor(getColors().secondaryActionSurface)
            .fontColor(getColors().ink)
            .onClick(() => {
              this.loadState = 'loading';
              this.loadPixelMap();
            })
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
        .borderRadius(8)
        .backgroundColor('rgba(0,0,0,0.13)')
      } else {
        Row({ space: 8 }) {
          LoadingProgress()
            .width(16)
            .height(16)
          Text(this.statusLabel())
            .fontSize(12)
            .fontColor(getColors().muted)
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
        .borderRadius(8)
        .backgroundColor('rgba(0,0,0,0.13)')
      }
    }
    .width('100%')
  }
}
