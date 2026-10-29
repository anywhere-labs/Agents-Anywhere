import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct SessionActionMenuOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop sessionTitle: string = '';
  @Prop archived: boolean = false;
  @Prop pinned: boolean = false;
  onRename: () => void = () => {};
  onToggleArchived: () => void = () => {};
  onTogglePinned: () => void = () => {};
  onClose: () => void = () => {};

  @Builder
  menuRow(label: ResourceStr, action: () => void) {
    Row() {
      Text(label)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .lineHeight(20)
        .fontColor(getColors().inkSoft)
        .layoutWeight(1)
    }
    .width('100%')
    .height(50)
    .padding({ left: 20, right: 20 })
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
      .backgroundColor(this.themeIsDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.4)')
      .onClick(() => {
        this.onClose();
      })
      Column() {
        Text(this.sessionTitle)
          .fontSize(13)
          .fontColor(getColors().faint)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .padding({ top: 12, left: 20, right: 20 })
        this.menuRow($r('app.string.common_rename'), (): void => {
          this.onRename();
        })
        Divider()
          .color(getColors().border)
        this.menuRow(this.archived ? $r('app.string.common_unarchive') : $r('app.string.common_archive'), (): void => {
          this.onToggleArchived();
        })
        Divider()
          .color(getColors().border)
        this.menuRow(this.pinned ? $r('app.string.common_unpin') : $r('app.string.common_pin'), (): void => {
          this.onTogglePinned();
        })
        Divider()
          .color(getColors().border)
        this.menuRow($r('app.string.common_cancel'), (): void => {
          this.onClose();
        })
      }
      .width('72%')
      .borderRadius(22)
      .backgroundColor(getColors().raisedSurface)
      .border({ width: 1, color: getColors().border })
      .padding({ top: 7, bottom: 7 })
    }
    .width('100%')
    .height('100%')
  }
}
