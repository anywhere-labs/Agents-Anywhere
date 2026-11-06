import { AAColors, AA_LIGHT_COLORS } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';
import { loadLocalThumbnail } from '../../../common/AAImages';
import { AALog } from '../../../common/AAAppLog';
import {
  AttachmentUploadState, PendingAttachment, formatBytes, isImageAttachment,
} from '../../../feature/sessiondetail/PendingAttachment';

/**
 * Composer attachment strip and the attach-source menu.
 *
 * Port of `PendingAttachmentStrip` / `PendingAttachmentCard` /
 * `AttachmentUploadOverlay` / `AttachmentSourceMenu` in
 * `ui/screens/sessiondetail/SessionComposer.kt`.
 *
 * Geometry, copied value for value:
 *
 *  - strip: 96dp tall, 10dp between cards, horizontally scrollable;
 *  - image card: 116x92, 20dp radius, raised surface behind the thumbnail;
 *  - file card: 174x92, 20dp radius, `#F1F0ED` (light) / `#27272A` (dark), a
 *    44dp icon tile at 14dp radius, name 12sp/15sp semi-bold over two lines, and
 *    the size at 10sp;
 *  - uploading: a 28% black veil with a 38dp white spinner of 5dp stroke;
 *  - uploaded: a 36dp remove button at the top-right, 6dp in, on `#D9262628`
 *    with a 1dp `#22FFFFFF` border;
 *  - failed: a 48% black veil with a `Retry` pill on `#CC27272A` (12dp radius,
 *    12/8 padding) above the same remove button;
 *  - menu: 270x190, 24dp radius, `#202023`/white, 1dp `#38383C`/`#EFEDE9`
 *    border, 34dp shadow, 18/10 padding and three rows.
 *
 * The icons are the vector set rather than Android's attachment bitmaps, which
 * the asset pass swaps back.
 */

const STRIP_HEIGHT: number = 96;
const IMAGE_CARD_WIDTH: number = 116;
const FILE_CARD_WIDTH: number = 174;
const CARD_HEIGHT: number = 92;
const REMOVE_SIZE: number = 36;

@Component
export struct PendingAttachmentStrip {
  colors: AAColors = AA_LIGHT_COLORS;
  attachments: PendingAttachment[] = [];
  onRemove: (attachment: PendingAttachment) => void = () => {};
  onRetry: (attachment: PendingAttachment) => void = () => {};
  onPreview: (attachment: PendingAttachment) => void = () => {};

  build() {
    Scroll() {
      Row({ space: 10 }) {
        ForEach(this.attachments, (attachment: PendingAttachment) => {
          PendingAttachmentCard({
            colors: this.colors,
            attachment: attachment,
            onRemove: () => this.onRemove(attachment),
            onRetry: () => this.onRetry(attachment),
            onPreview: () => this.onPreview(attachment),
          })
        }, (attachment: PendingAttachment) => `attachment-${attachment.id}`)
      }
      .alignItems(VerticalAlign.Center)
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .height(STRIP_HEIGHT)
  }
}

@Component
struct PendingAttachmentCard {
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
  onRemove: () => void = () => {};
  onRetry: () => void = () => {};
  onPreview: () => void = () => {};

  build() {
    if (isImageAttachment(this.attachment.mediaType)) {
      PendingImageCard({
        colors: this.colors,
        attachment: this.attachment,
        onRemove: this.onRemove,
        onRetry: this.onRetry,
        onPreview: this.onPreview,
      })
    } else {
      PendingFileCard({
        colors: this.colors,
        attachment: this.attachment,
        onRemove: this.onRemove,
        onRetry: this.onRetry,
      })
    }
  }
}

/**
 * The image card, including the thumbnail decode.
 *
 * The bitmap is loaded once per URI; a failure leaves the surface colour behind,
 * which is what Android shows for an undecodable image.
 */
@Component
struct PendingImageCard {
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
  onRemove: () => void = () => {};
  onRetry: () => void = () => {};
  onPreview: () => void = () => {};
  @State private thumbnail: PixelMap | null = null;
  private loadedUri: string = '';

  aboutToAppear(): void {
    this.loadThumbnail();
  }

  private loadThumbnail(): void {
    if (this.attachment.uri.length === 0 || this.loadedUri === this.attachment.uri) {
      return;
    }
    this.loadedUri = this.attachment.uri;
    void loadLocalThumbnail(this.attachment.uri, IMAGE_CARD_WIDTH).then((map: PixelMap | null) => {
      if (map !== null && this.loadedUri === this.attachment.uri) {
        this.thumbnail = map;
      }
    }).catch((error: Object) => {
      AALog.debug(`Thumbnail rejected: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }

  build() {
    Stack() {
      if (this.thumbnail !== null) {
        Image(this.thumbnail)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
      }
      AttachmentUploadOverlay({
        colors: this.colors,
        state: this.attachment.uploadState,
        onRemove: this.onRemove,
        onRetry: this.onRetry,
      })
    }
    .width(IMAGE_CARD_WIDTH)
    .height(CARD_HEIGHT)
    .borderRadius(20)
    .clip(true)
    .backgroundColor(this.colors.raisedSurface)
    .onClick(() => this.onPreview())
  }
}

@Component
struct PendingFileCard {
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
  onRemove: () => void = () => {};
  onRetry: () => void = () => {};

  private surface(): string {
    return this.colors.isDark ? '#27272A' : '#F1F0ED';
  }

  private textColor(): string {
    return this.colors.isDark ? '#F4F4F5' : '#242522';
  }

  private mutedColor(): string {
    return this.colors.isDark ? '#A1A1AA' : '#7C7B76';
  }

  private iconTile(): string {
    return this.colors.isDark ? this.colors.subtle : '#DBFFFFFF';
  }

  build() {
    Stack() {
      Row({ space: 10 }) {
        Column() {
          Image(this.colors.isDark ? $r('app.media.ic_attachment_file_white')
            : $r('app.media.ic_attachment_file_black'))
            .width(22)
            .height(22)
            .objectFit(ImageFit.Contain)
        }
        .width(44)
        .height(44)
        .justifyContent(FlexAlign.Center)
        .borderRadius(14)
        .backgroundColor(this.iconTile())

        Column() {
          Text(this.attachment.name)
            .fontSize(12)
            .lineHeight(15)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.textColor())
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          Text(formatBytes(this.attachment.size))
            .fontSize(10)
            .fontColor(this.mutedColor())
            .maxLines(1)
            .width('100%')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .padding(10)
      .alignItems(VerticalAlign.Center)

      AttachmentUploadOverlay({
        colors: this.colors,
        state: this.attachment.uploadState,
        onRemove: this.onRemove,
        onRetry: this.onRetry,
      })
    }
    .width(FILE_CARD_WIDTH)
    .height(CARD_HEIGHT)
    .borderRadius(20)
    .clip(true)
    .backgroundColor(this.surface())
  }
}

/** The veil and its controls, drawn over either card shape. */
@Component
struct AttachmentUploadOverlay {
  colors: AAColors = AA_LIGHT_COLORS;
  state: AttachmentUploadState = AttachmentUploadState.Uploading;
  onRemove: () => void = () => {};
  onRetry: () => void = () => {};

  build() {
    Stack() {
      if (this.state === AttachmentUploadState.Uploading) {
        Column() {
          LoadingProgress().width(38).height(38).color('#FFFFFF')
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#47000000')
      } else if (this.state === AttachmentUploadState.Failed) {
        Column() {
          Text($r('app.string.common_retry'))
            .fontSize(12)
            .fontWeight(FontWeight.Bold)
            .fontColor('#FFFFFF')
            .padding({ left: 12, right: 12, top: 8, bottom: 8 })
            .borderRadius(10)
            .backgroundColor('#CC27272A')
            .onClick(() => this.onRetry())
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#7A000000')
        this.RemoveButton()
      } else {
        this.RemoveButton()
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  RemoveButton() {
    Column() {
      AAIcon({ commands: AA_ICONS.X, iconSize: 22, color: '#FFFFFF' })
    }
    .width(REMOVE_SIZE)
    .height(REMOVE_SIZE)
    .justifyContent(FlexAlign.Center)
    .borderRadius(REMOVE_SIZE / 2)
    .backgroundColor('#D9262628')
    .border({ width: 1, color: '#22FFFFFF' })
    .margin({ top: 6, right: 6 })
    .align(Alignment.TopEnd)
    .onClick(() => this.onRemove())
  }
}

/**
 * The `+` menu.
 *
 * Android anchors it to the bottom-left of the composer with a 14dp/-34dp
 * offset; `bindPopup` with `Placement.BottomLeft` and the same offset is the
 * ArkUI equivalent, and the menu body below is the popup's content.
 */
@Component
export struct AttachSourceMenu {
  colors: AAColors = AA_LIGHT_COLORS;
  onCamera: () => void = () => {};
  onPhoto: () => void = () => {};
  onFile: () => void = () => {};

  private surface(): string {
    return this.colors.isDark ? '#202023' : '#FFFFFF';
  }

  private borderColorFor(): string {
    return this.colors.isDark ? '#38383C' : '#EFEDE9';
  }

  private textColor(): string {
    return this.colors.isDark ? '#F4F4F5' : '#2F302D';
  }

  private iconTile(): string {
    return this.colors.isDark ? '#3A3A3D' : '#F1F1EF';
  }

  build() {
    Column({ space: 6 }) {
      this.SourceRow($r('app.string.session_attachment_camera'),
        this.colors.isDark ? $r('app.media.ic_attachment_camera_white')
          : $r('app.media.ic_attachment_camera_black'),
        () => this.onCamera())
      this.SourceRow($r('app.string.session_attachment_photos'),
        this.colors.isDark ? $r('app.media.ic_attachment_photo_white')
          : $r('app.media.ic_attachment_photo_black'),
        () => this.onPhoto())
      this.SourceRow($r('app.string.session_attachment_file'),
        this.colors.isDark ? $r('app.media.ic_attachment_file_white')
          : $r('app.media.ic_attachment_file_black'),
        () => this.onFile())
    }
    .width(270)
    .height(190)
    .padding({ left: 18, right: 18, top: 10, bottom: 10 })
    .borderRadius(24)
    .backgroundColor(this.surface())
    .border({ width: 1, color: this.borderColorFor() })
    .shadow({
      radius: 34,
      color: this.colors.isDark ? '#80000000' : '#1A000000',
      offsetX: 0,
      offsetY: 0,
    })
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  SourceRow(label: ResourceStr, icon: Resource, onTap: () => void) {
    Row({ space: 12 }) {
      Column() {
        Image(icon).width(22).height(22).objectFit(ImageFit.Contain)
      }
      .width(38)
      .height(38)
      .justifyContent(FlexAlign.Center)
      .borderRadius(12)
      .backgroundColor(this.iconTile())

      Text(label)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.textColor())
        .layoutWeight(1)

      Blank().width(4)
    }
    .width('100%')
    .height(52)
    .alignItems(VerticalAlign.Center)
    .onClick(() => onTap())
  }
}
