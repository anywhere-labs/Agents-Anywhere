import { image } from '@kit.ImageKit';
import { RemoteTimelineAttachment } from 'network';
import { APP_IS_DARK_KEY, getColors } from 'common';
import { loadAttachmentPixelMap } from './AttachmentImageView';

const ATTACHMENT_PREVIEW_MAX_SCALE = 4;

@Component
struct AttachmentPreviewThumb {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop sessionId: string = '';
  @Prop fileId: string = '';
  @Prop fileName: string = '';
  @Prop selected: boolean = false;
  onTap: () => void = () => {};
  @State pixelMap: image.PixelMap | undefined = undefined;

  aboutToAppear(): void {
    this.loadThumb();
  }

  private async loadThumb(): Promise<void> {
    if (this.fileId.length === 0 || this.sessionId.length === 0) {
      return;
    }
    try {
      this.pixelMap = await loadAttachmentPixelMap(this.sessionId, this.fileId);
    } catch (error) {
      return;
    }
  }

  private thumbSurface(): string {
    return this.themeIsDark ? '#27272A' : '#F1F0ED';
  }

  private selectionBorder(): string {
    return this.themeIsDark ? '#F4F4F5' : '#4B4B47';
  }

  build() {
    Column() {
      if (this.pixelMap !== undefined) {
        Image(this.pixelMap)
          .objectFit(ImageFit.Cover)
          .width('100%')
          .height('100%')
      } else {
        Column() {
          Text(this.fileName)
            .fontSize(12)
            .fontColor(getColors().muted)
            .maxLines(2)
            .textAlign(TextAlign.Center)
        }
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .width('100%')
        .height('100%')
        .backgroundColor(this.thumbSurface())
      }
    }
    .width(58)
    .height(58)
    .borderRadius(8)
    .clip(true)
    .padding(this.selected ? 3 : 0)
    .border({ width: 2, color: this.selected ? this.selectionBorder() : 'transparent' })
    .backgroundColor(this.thumbSurface())
    .onClick(() => {
      this.onTap();
    })
  }
}

@Component
struct AttachmentPreviewImage {
  @Prop sessionId: string = '';
  @Prop fileId: string = '';
  @Prop fileName: string = '';
  onTapClose: () => void = () => {};
  @State pixelMap: image.PixelMap | undefined = undefined;
  @State loadState: string = 'loading';
  @State previewScale: number = 1;
  private pinchBaseScale: number = 1;

  aboutToAppear(): void {
    this.loadImage();
  }

  private async loadImage(): Promise<void> {
    if (this.fileId.length === 0 || this.sessionId.length === 0) {
      this.loadState = 'failed';
      return;
    }
    try {
      this.pixelMap = await loadAttachmentPixelMap(this.sessionId, this.fileId);
      this.loadState = 'loaded';
    } catch (error) {
      this.loadState = 'failed';
    }
  }

  private applyPinch(scale: number): void {
    const next = this.pinchBaseScale * scale;
    if (next < 1) {
      this.previewScale = 1;
      return;
    }
    if (next > ATTACHMENT_PREVIEW_MAX_SCALE) {
      this.previewScale = ATTACHMENT_PREVIEW_MAX_SCALE;
      return;
    }
    this.previewScale = next;
  }

  build() {
    Column() {
      if (this.loadState === 'loaded' && this.pixelMap !== undefined) {
        Image(this.pixelMap)
          .objectFit(ImageFit.Contain)
          .width('100%')
          .height('100%')
          .scale({ x: this.previewScale, y: this.previewScale })
          .gesture(
            PinchGesture({ fingers: 2 })
              .onActionStart(() => {
                this.pinchBaseScale = this.previewScale;
              })
              .onActionUpdate((event: GestureEvent) => {
                this.applyPinch(event.scale);
              })
              .onActionEnd(() => {
                this.applyPinch(1);
              })
          )
      } else if (this.loadState === 'failed') {
        Column({ space: 8 }) {
          Text(this.fileName)
            .fontSize(13)
            .fontColor(getColors().muted)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .textAlign(TextAlign.Center)
          Text($r('app.string.session_attachment_load_failed'))
            .fontSize(12)
            .fontColor(getColors().muted)
        }
        .alignItems(HorizontalAlign.Center)
        .justifyContent(FlexAlign.Center)
        .width('100%')
        .height('100%')
      } else {
        Column({ space: 10 }) {
          LoadingProgress()
            .width(28)
            .height(28)
            .color(getColors().muted)
          Text($r('app.string.session_attachment_loading'))
            .fontSize(12)
            .fontColor(getColors().muted)
        }
        .alignItems(HorizontalAlign.Center)
        .justifyContent(FlexAlign.Center)
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
    .onClick(() => {
      this.onTapClose();
    })
  }
}

@Component
export struct AttachmentPreviewOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop sessionId: string = '';
  @Prop attachments: RemoteTimelineAttachment[] = [];
  @Prop initialIndex: number = 0;
  onSave: (attachment: RemoteTimelineAttachment) => void = () => {};
  onClose: () => void = () => {};
  @State currentIndex: number = 0;
  private thumbnailScroller: Scroller = new Scroller();

  aboutToAppear(): void {
    this.currentIndex = this.initialIndex;
  }

  private previewBackground(): string {
    return this.themeIsDark ? '#000000' : getColors().canvas;
  }

  private actionSurface(): string {
    return this.themeIsDark ? 'rgba(63,63,70,0.85)' : 'rgba(231,229,224,0.9)';
  }

  private actionContent(): string {
    return this.themeIsDark ? '#F4F4F5' : '#4B4B47';
  }

  private currentAttachment(): RemoteTimelineAttachment | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.attachments.length) {
      return null;
    }
    return this.attachments[this.currentIndex];
  }

  private saveCurrent(): void {
    const current = this.currentAttachment();
    if (current === null) {
      return;
    }
    this.onSave(current);
  }

  private moveToIndex(index: number): void {
    this.currentIndex = index;
    if (this.attachments.length > 1) {
      this.thumbnailScroller.scrollToIndex(index);
    }
  }

  build() {
    Stack() {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.previewBackground())
      .onClick(() => {
        this.onClose();
      })

      Column() {
        Row() {
          Blank()
          Row({ space: 10 }) {
            Text('⇩')
              .fontSize(17)
              .width(46)
              .height(46)
              .borderRadius(23)
              .textAlign(TextAlign.Center)
              .backgroundColor(this.actionSurface())
              .fontColor(this.actionContent())
              .onClick(() => {
                this.saveCurrent();
              })
            Text('✕')
              .fontSize(17)
              .width(46)
              .height(46)
              .borderRadius(23)
              .textAlign(TextAlign.Center)
              .backgroundColor(this.actionSurface())
              .fontColor(this.actionContent())
              .onClick(() => {
                this.onClose();
              })
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 12 })

        Swiper() {
          ForEach(this.attachments, (attachment: RemoteTimelineAttachment) => {
            AttachmentPreviewImage({
              sessionId: this.sessionId,
              fileId: attachment.fileId,
              fileName: attachment.name,
              onTapClose: (): void => {
                this.onClose();
              }
            })
          }, (attachment: RemoteTimelineAttachment) => attachment.fileId)
        }
        .index(this.currentIndex)
        .loop(false)
        .indicator(false)
        .onChange((index: number) => {
          this.moveToIndex(index);
        })
        .layoutWeight(1)
        .width('100%')

        if (this.attachments.length > 1) {
          List({ scroller: this.thumbnailScroller, space: 8 }) {
            ForEach(this.attachments, (attachment: RemoteTimelineAttachment, thumbIndex: number) => {
              ListItem() {
                AttachmentPreviewThumb({
                  sessionId: this.sessionId,
                  fileId: attachment.fileId,
                  fileName: attachment.name,
                  selected: thumbIndex === this.currentIndex,
                  onTap: (): void => {
                    this.moveToIndex(thumbIndex);
                  }
                })
              }
            }, (attachment: RemoteTimelineAttachment, thumbIndex: number) =>
              `${attachment.fileId}_${thumbIndex === this.currentIndex}`)
          }
          .listDirection(Axis.Horizontal)
          .scrollBar(BarState.Off)
          .width('100%')
          .height(72)
          .padding({ left: 16, right: 16 })
          .align(Alignment.Center)
        }
      }
      .width('100%')
      .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
