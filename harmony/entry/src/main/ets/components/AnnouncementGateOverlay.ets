import { MdBlock } from 'common';
import { AgentMarkdownView } from 'session';
import { APP_IS_DARK_KEY, getColors } from 'common';

@Component
export struct AnnouncementGateOverlay {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  blocks: MdBlock[] = [];
  onClose: () => void = () => {};

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
      Column({ space: 16 }) {
        Text($r('app.string.announcement_title'))
          .fontSize(20)
          .fontWeight(600)
          .lineHeight(24)
          .fontColor(getColors().ink)
          .width('100%')
        Scroll() {
          Column() {
            AgentMarkdownView({
              blocks: this.blocks,
              textColor: getColors().inkSoft,
              linkColor: getColors().primaryAction,
              inlineCodeColor: getColors().mdInlineOnSurface,
              codePanelColor: getColors().sessionCodeSurface,
              codePanelTextColor: getColors().mdCodeOnSurface,
              fontSize: 14
            })
          }
          .constraintSize({ minHeight: 20 })
          .width('100%')
        }
        .layoutWeight(1)
        .align(Alignment.TopStart)
        .width('100%')
        .constraintSize({ maxHeight: 320 })
        Button($r('app.string.announcement_acknowledge'))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(getColors().onPrimaryAction)
          .backgroundColor(getColors().primaryAction)
          .height(40)
          .borderRadius(20)
          .width('100%')
          .onClick(() => {
            this.onClose();
          })
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
