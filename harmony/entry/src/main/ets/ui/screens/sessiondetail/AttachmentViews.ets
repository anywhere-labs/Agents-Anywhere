import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { AAToastHost, AAToastState } from '../../designsystem/AAToast';
import { decodeImageBytes, loadLocalThumbnail } from '../../../common/AAImages';
import { TimelineAttachment } from '../../../feature/sessiondetail/SessionTimelineProjection';
import {
  AttachmentUploadState, PendingAttachment, formatBytes, isImageAttachment,
} from '../../../feature/sessiondetail/PendingAttachment';

/**
 * Attachments in the conversation, and the full-screen viewer.
 *
 * Port of `UserAttachmentStrip` / `UserFileAttachmentCard` in
 * `SessionMessages.kt` and of `AttachmentPreviewDialog` in `AttachmentImages.kt`.
 *
 * Geometry, copied value for value:
 *
 *  - conversation image: 196x142 at 14dp radius, cropped, tapping opens the viewer;
 *  - conversation file card: 224x72 at 18dp radius on the message bubble colour,
 *    10dp padding, a 42dp icon tile at 14dp radius on `raisedSurface` at 86%, the
 *    name at 13sp semi-bold on one line and the size at 11sp muted;
 *  - viewer: full-screen on `#000000` (dark) or `#FFFFFF` (light), pages inset
 *    12dp with room for the 46dp actions and a 104dp bottom band, a 58dp
 *    thumbnail strip at 8dp radius whose selected tile takes a 2dp selection
 *    border and 3dp inset, and two 46dp circular actions at the top-right;
 *  - viewer palette: actions `#D93F3F46`/`#E6E7E5E0` with
 *    `#F4F4F5`/`#4B4B47` glyphs, thumbnails `#27272A`/`#F1F0ED`, selection
 *    `#F4F4F5`/`#4B4B47`, fallback text `#A1A1AA`/`#777777`.
 *
 * Android loads remote images through Coil with an `Authorization` header; here
 * the bytes are fetched through the controller's transport and decoded by
 * ImageKit, which needs no disk cache because the screen holds them in memory.
 * An image that cannot be decoded falls back to its file name on a 13% veil,
 * which is Android's `ImageFallback`.
 */

/** Viewer palette; a fixed literal set on Android, so it is fixed here too. */
export interface AttachmentPreviewPalette {
  background: string;
  actionSurface: string;
  actionContent: string;
  thumbnailSurface: string;
  selectionBorder: string;
  fallbackText: string;
}

export function attachmentPreviewPalette(dark: boolean): AttachmentPreviewPalette {
  if (dark) {
    return {
      background: '#000000',
      actionSurface: '#D93F3F46',
      actionContent: '#F4F4F5',
      thumbnailSurface: '#27272A',
      selectionBorder: '#F4F4F5',
      fallbackText: '#A1A1AA',
    };
  }
  return {
    background: '#FFFFFF',
    actionSurface: '#E6E7E5E0',
    actionContent: '#4B4B47',
    thumbnailSurface: '#F1F0ED',
    selectionBorder: '#4B4B47',
    fallbackText: '#777777',
  };
}

/**
 * A composer attachment's own image, before it is sent.
 *
 * Android previews it through the same dialog as a sent image; here it needs its
 * own surface because the pager is built from timeline attachments, and a pending
 * one has no file id yet.
 */
@Component
export struct LocalImageViewer {
  colors: AAColors = AA_LIGHT_COLORS;
  attachment: PendingAttachment = {
    id: '',
    name: '',
    mediaType: '',
    size: 0,
    uri: '',
    uploadState: AttachmentUploadState.Uploading,
    remote: null,
    errorMessage: null,
  };
  statusBarHeight: number = 0;
  onClose: () => void = () => {};
  @State private pixelMap: PixelMap | null = null;

  aboutToAppear(): void {
    this.load();
  }

  private load(): void {
    if (this.attachment.uri.length === 0) {
      return;
    }
    void loadLocalThumbnail(this.attachment.uri, 900).then((map: PixelMap | null) => {
      this.pixelMap = map;
    });
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        if (this.pixelMap !== null) {
          Image(this.pixelMap)
            .width('100%')
            .height('100%')
            .objectFit(ImageFit.Contain)
        } else {
          Text(this.attachment.name)
            .fontSize(12)
            .fontColor(attachmentPreviewPalette(this.colors.isDark).fallbackText)
            .maxLines(2)
            .textAlign(TextAlign.Center)
            .padding(10)
        }
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .padding({
        left: 12, right: 12, top: this.statusBarHeight + 68, bottom: 118,
      })

      Row() {
        Blank().layoutWeight(1)
        Column() {
          AAIcon({
            commands: AA_ICONS.X,
            iconSize: 22,
            color: attachmentPreviewPalette(this.colors.isDark).actionContent,
          })
        }
        .width(46)
        .height(46)
        .justifyContent(FlexAlign.Center)
        .borderRadius(23)
        .backgroundColor(attachmentPreviewPalette(this.colors.isDark).actionSurface)
        .onClick(() => this.onClose())
      }
      .width('100%')
      .padding({ top: this.statusBarHeight + 12, left: 16, right: 16 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(attachmentPreviewPalette(this.colors.isDark).background)
  }
}

/**
 * A remote image, loaded once per file id.
 *
 * `load` is supplied by the screen so this component stays free of the API
 * layer; the screen hands in the controller's download call.
 */
@Component
export struct RemoteAttachmentImage {
  colors: AAColors = AA_LIGHT_COLORS;
  attachment: TimelineAttachment = { fileId: '', name: '', mediaType: '', size: 0 };
  /** Requested decode size in vp; the bitmap is scaled to it. */
  targetSize: number = 196;
  fallbackColor: string = '#A1A1AA';
  onTap: () => void = () => {};
  load: (attachment: TimelineAttachment) => Promise<ArrayBuffer | null> =
    (attachment: TimelineAttachment) => Promise.resolve(null);
  @State private pixelMap: PixelMap | null = null;
  @State private failed: boolean = false;
  private loadedFileId: string = '';

  aboutToAppear(): void {
    this.loadImage();
  }

  private loadImage(): void {
    if (this.attachment.fileId.length === 0 || this.loadedFileId === this.attachment.fileId) {
      return;
    }
    this.loadedFileId = this.attachment.fileId;
    void this.load(this.attachment).then((bytes: ArrayBuffer | null) => {
      if (bytes === null) {
        this.failed = true;
        return;
      }
      return decodeImageBytes(bytes, this.targetSize).then((map: PixelMap | null) => {
        if (this.loadedFileId !== this.attachment.fileId) {
          return;
        }
        if (map === null) {
          this.failed = true;
        } else {
          this.pixelMap = map;
        }
      });
    }).catch(() => {
      this.failed = true;
    });
  }

  build() {
    Stack() {
      if (this.pixelMap !== null) {
        Image(this.pixelMap)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
      } else if (this.failed) {
        Column() {
          Text(this.attachment.name)
            .fontSize(12)
            .fontColor(this.fallbackColor)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .textAlign(TextAlign.Center)
            .padding(10)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#22000000')
      }
    }
    .width('100%')
    .height('100%')
    .onClick(() => this.onTap())
  }
}

/** One attachment inside a message: an image tile or a file card. */
@Component
export struct MessageAttachmentItem {
  colors: AAColors = AA_LIGHT_COLORS;
  attachment: TimelineAttachment = { fileId: '', name: '', mediaType: '', size: 0 };
  onPreview: (attachment: TimelineAttachment) => void = () => {};
  onOpen: (attachment: TimelineAttachment) => void = () => {};
  load: (attachment: TimelineAttachment) => Promise<ArrayBuffer | null> =
    (attachment: TimelineAttachment) => Promise.resolve(null);

  build() {
    if (isImageAttachment(this.attachment.mediaType)) {
      RemoteAttachmentImage({
        colors: this.colors,
        attachment: this.attachment,
        targetSize: 196,
        fallbackColor: this.colors.isDark ? '#A1A1AA' : '#777777',
        load: this.load,
        onTap: () => this.onPreview(this.attachment),
      })
        .width(196)
        .height(142)
        .borderRadius(14)
        .clip(true)
    } else {
      Row({ space: 10 }) {
        Column() {
          AAIcon({
            commands: AA_ICONS.FILE,
            iconSize: 22,
            color: this.colors.sessionMessageText,
          })
        }
        .width(42)
        .height(42)
        .justifyContent(FlexAlign.Center)
        .borderRadius(14)
        .backgroundColor('#DBFFFFFF')

        Column() {
          Text(this.attachment.name)
            .fontSize(13)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.colors.sessionMessageText)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          Text(formatBytes(this.attachment.size))
            .fontSize(11)
            .fontColor(this.colors.muted)
            .maxLines(1)
            .width('100%')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width(224)
      .height(72)
      .padding(10)
      .borderRadius(18)
      .backgroundColor(this.colors.sessionMessageBubble)
      .alignItems(VerticalAlign.Center)
      .onClick(() => this.onOpen(this.attachment))
    }
  }
}

/** The strip above a message bubble, oldest first, as Android draws it. */
@Component
export struct MessageAttachmentStrip {
  colors: AAColors = AA_LIGHT_COLORS;
  attachments: TimelineAttachment[] = [];
  alignEnd: boolean = false;
  onPreview: (attachment: TimelineAttachment) => void = () => {};
  onOpen: (attachment: TimelineAttachment) => void = () => {};
  load: (attachment: TimelineAttachment) => Promise<ArrayBuffer | null> =
    (attachment: TimelineAttachment) => Promise.resolve(null);

  build() {
    if (this.attachments.length > 0) {
      Column({ space: 8 }) {
        ForEach(this.attachments, (attachment: TimelineAttachment) => {
          MessageAttachmentItem({
            colors: this.colors,
            attachment: attachment,
            onPreview: this.onPreview,
            onOpen: this.onOpen,
            load: this.load,
          })
        }, (attachment: TimelineAttachment) => `attachment-${attachment.fileId}`)
      }
      .alignItems(this.alignEnd ? HorizontalAlign.End : HorizontalAlign.Start)
    }
  }
}

/**
 * The full-screen viewer.
 *
 * Android renders this in a `Dialog` with a horizontal pager, a thumbnail strip
 * and two actions; the screen hosts this component in a `bindContentCover`, so
 * the pager and the strip are the only layout decisions left here.
 */
@Component
export struct AttachmentPreviewViewer {
  colors: AAColors = AA_LIGHT_COLORS;
  /** Every image in the session, so the viewer can page between them. */
  images: TimelineAttachment[] = [];
  /** The attachment the user opened; its index selects the first page. */
  initialFileId: string = '';
  statusBarHeight: number = 0;
  onClose: () => void = () => {};
  onDownload: (attachment: TimelineAttachment) => void = () => {};
  load: (attachment: TimelineAttachment) => Promise<ArrayBuffer | null> =
    (attachment: TimelineAttachment) => Promise.resolve(null);
  /** Download feedback; the viewer owns its own toast because it covers the page. */
  previewToast: ResourceStr = '';
  @Prop @Watch('onPreviewToastChanged') previewToastRequest: number;
  @State private page: number = 0;
  private toast: AAToastState = new AAToastState();

  onPreviewToastChanged(): void {
    if (this.previewToastRequest > 0) {
      this.toast.show(this.previewToast, false);
    }
  }

  aboutToAppear(): void {
    const index: number = this.indexOf(this.initialFileId);
    this.page = index < 0 ? 0 : index;
  }

  private indexOf(fileId: string): number {
    for (let index = 0; index < this.images.length; index++) {
      if (this.images[index].fileId === fileId) {
        return index;
      }
    }
    return -1;
  }

  private palette(): AttachmentPreviewPalette {
    return attachmentPreviewPalette(this.colors.isDark);
  }

  private current(): TimelineAttachment | null {
    return this.page >= 0 && this.page < this.images.length ? this.images[this.page] : null;
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Swiper() {
        ForEach(this.images, (attachment: TimelineAttachment) => {
          RemoteAttachmentImage({
            colors: this.colors,
            attachment: attachment,
            targetSize: 900,
            fallbackColor: this.palette().fallbackText,
            load: this.load,
          })
            .width('100%')
            .height('100%')
        }, (attachment: TimelineAttachment) => `page-${attachment.fileId}`)
      }
      .index(this.page)
      .loop(false)
      .indicator(false)
      .width('100%')
      .height('100%')
      .padding({
        left: 12,
        right: 12,
        top: this.statusBarHeight + 68,
        bottom: 118,
      })
      .onChange((index: number) => {
        this.page = index;
      })

      Row({ space: 10 }) {
        Blank().layoutWeight(1)
        this.ActionButton(AA_ICONS.DOWNLOAD, $r('app.string.session_attachment_save'), () => {
          const current: TimelineAttachment | null = this.current();
          if (current !== null) {
            this.onDownload(current);
          }
        })
        this.ActionButton(AA_ICONS.X, $r('app.string.common_close'), () => this.onClose())
      }
      .width('100%')
      .padding({ top: this.statusBarHeight + 12, left: 16, right: 16 })

      Scroll() {
        Row({ space: 8 }) {
          ForEach(this.images, (attachment: TimelineAttachment, index: number) => {
            this.Thumbnail(attachment, index)
          }, (attachment: TimelineAttachment) => `thumb-${attachment.fileId}`)
        }
        .padding({ left: 16, right: 16 })
        .alignItems(VerticalAlign.Center)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .height(58)
      .align(Alignment.Bottom)
      .margin({ bottom: 14 })

      AAToastHost({
        colors: this.colors,
        message: this.toast.message,
        isError: this.toast.isError,
        actionLabel: this.toast.actionLabel,
        visible: this.toast.visible,
        onAction: () => this.toast.hide(),
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.palette().background)
  }

  @Builder
  ActionButton(icon: string, description: Resource, onTap: () => void) {
    Column() {
      AAIcon({ commands: icon, iconSize: 22, color: this.palette().actionContent })
    }
    .width(46)
    .height(46)
    .justifyContent(FlexAlign.Center)
    .borderRadius(23)
    .backgroundColor(this.palette().actionSurface)
    .accessibilityText(description)
    .onClick(() => onTap())
  }

  @Builder
  Thumbnail(attachment: TimelineAttachment, index: number) {
    Stack() {
      RemoteAttachmentImage({
        colors: this.colors,
        attachment: attachment,
        targetSize: 58,
        fallbackColor: this.palette().fallbackText,
        load: this.load,
        onTap: () => {
          this.page = index;
        },
      })
        .width('100%')
        .height('100%')
    }
    .width(58)
    .height(58)
    .borderRadius(8)
    .clip(true)
    .border({
      width: this.page === index ? 2 : 0,
      color: this.palette().selectionBorder,
    })
    .padding(this.page === index ? 3 : 0)
    .backgroundColor(this.palette().thumbnailSurface)
    // Android names a thumbnail after its attachment.
    .accessibilityText(attachment.name)
  }
}
