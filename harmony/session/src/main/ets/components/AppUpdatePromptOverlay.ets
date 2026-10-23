import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct AppUpdatePromptOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  versionName: string = '';
  onDownload: () => void = () => {};
  onIgnore: () => void = () => {};

  build() {
    Stack() {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor(this.themeIsDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.4)')
      .onClick(() => {
        this.onIgnore();
      })
      Column({ space: 16 }) {
        Text($r('app.string.update_available_title'))
          .fontSize(20)
          .fontWeight(600)
          .lineHeight(24)
          .fontColor(getColors().ink)
          .width('100%')
        Text($r('app.string.update_available_message', this.versionName))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(getColors().muted)
          .width('100%')
          .lineHeight(20)
        Row({ space: 10 }) {
          Button($r('app.string.update_ignore_version'))
            .fontSize(14)
            .fontWeight(600)
            .fontColor(getColors().ink)
            .backgroundColor(getColors().secondaryActionSurface)
            .height(46)
            .borderRadius(14)
            .layoutWeight(1)
            .onClick(() => {
              this.onIgnore();
            })
          Button($r('app.string.update_now'))
            .fontSize(14)
            .fontWeight(600)
            .fontColor(getColors().onPrimaryAction)
            .backgroundColor(getColors().primaryAction)
            .height(46)
            .borderRadius(14)
            .layoutWeight(1)
            .onClick(() => {
              this.onDownload();
            })
        }
        .width('100%')
      }
      .width('86%')
      .padding(20)
      .borderRadius(20)
      .backgroundColor(getColors().dialogSurface)
      .border({ width: 1, color: getColors().border })
    }
    .width('100%')
    .height('100%')
  }
}
