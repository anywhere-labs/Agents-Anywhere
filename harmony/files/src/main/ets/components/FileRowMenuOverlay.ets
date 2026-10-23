import { getColors } from 'common';

@Component
export struct FileRowMenuOverlay {
  @Prop entryName: string = '';
  onCopyPath: () => void = () => {};
  onClose: () => void = () => {};

  @Builder
  menuRow(label: ResourceStr, action: () => void) {
    Row() {
      Text(label)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(getColors().ink)
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ top: 13, bottom: 13, left: 16, right: 16 })
    .onClick(() => {
      action();
    })
  }

  build() {
    Stack() {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor('rgba(0,0,0,0.45)')
      .onClick(() => {
        this.onClose();
      })
      Column() {
        Text(this.entryName)
          .fontSize(13)
          .fontColor(getColors().muted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .padding({ top: 12, left: 16, right: 16 })
        this.menuRow($r('app.string.files_copy_path'), (): void => {
          this.onCopyPath();
        })
        Divider()
          .color(getColors().border)
        this.menuRow($r('app.string.profile_cancel'), (): void => {
          this.onClose();
        })
      }
      .width('72%')
      .borderRadius(16)
      .backgroundColor(getColors().dialogSurface)
      .padding({ bottom: 6 })
    }
    .width('100%')
    .height('100%')
  }
}
