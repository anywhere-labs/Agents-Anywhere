import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct HomeProjectArchiveDialog {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop projectName: string = '';
  @Prop busy: boolean = false;
  onConfirm: () => void = () => {};
  onDismiss: () => void = () => {};

  @Builder
  dialogButton(label: ResourceStr, enabled: boolean, primary: boolean, action: () => void) {
    Row() {
      Text(label)
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor(primary ? getColors().onPrimaryAction : getColors().ink)
    }
    .layoutWeight(1)
    .height(50)
    .justifyContent(FlexAlign.Center)
    .borderRadius(16)
    .backgroundColor(primary ? getColors().primaryAction : getColors().secondaryActionSurface)
    .opacity(enabled ? 1 : 0.38)
    .onClick(() => {
      if (enabled) {
        action();
      }
    })
  }

  build() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.themeIsDark ? '#99000000' : '#66000000')
        .onClick(() => {
          if (!this.busy) {
            this.onDismiss();
          }
        })
      Column({ space: 16 }) {
        Text($r('app.string.home_project_archive_title'))
          .fontSize(22)
          .fontWeight(800)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.home_project_archive_description', this.projectName))
          .fontSize(14)
          .lineHeight(20)
          .fontColor(getColors().muted)
          .width('100%')
        Row({ space: 10 }) {
          this.dialogButton($r('app.string.common_cancel'), !this.busy, false, (): void => {
            this.onDismiss();
          })
          this.dialogButton($r('app.string.home_project_archive'), !this.busy, true, (): void => {
            this.onConfirm();
          })
        }
        .width('100%')
      }
      .constraintSize({ maxWidth: 380 })
      .padding(22)
      .borderRadius(26)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
      .margin({ left: 22, right: 22 })
    }
    .width('100%')
    .height('100%')
  }
}
