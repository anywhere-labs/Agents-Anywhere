import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AAIcon } from '../../designsystem/AAIcon';
import { AA_ICONS } from '../../designsystem/AAIcons';

/**
 * The reply actions under a completed turn.
 *
 * Port of `AgentReplyActions`, `MessageCopyButton` and `MessageShareButton` in
 * `ui/screens/sessiondetail/SessionMessages.kt`: a 1dp divider at half the border
 * colour, then a row of 30dp circular buttons — copy, then share — in the muted
 * ink.
 *
 * The copy button keeps Android's bitmap pair (`ic_copy_bash_command_*`) rather
 * than a glyph, because that is what Android draws and what the port already uses
 * for the code panel's copy button.
 */
@Component
export struct SessionReplyActions {
  colors: AAColors = AA_LIGHT_COLORS;
  onCopy: () => void = () => {};
  onShare: () => void = () => {};

  build() {
    Column({ space: 5 }) {
      Column()
        .width('100%')
        .height(1)
        .backgroundColor(withAlpha(this.colors.border, 0.5))

      Row({ space: 4 }) {
        Column() {
          Image(this.colors.isDark ? $r('app.media.ic_copy_bash_command_dark')
            : $r('app.media.ic_copy_bash_command_light'))
            .width(17)
            .height(17)
            .objectFit(ImageFit.Contain)
        }
        .width(30)
        .height(30)
        .justifyContent(FlexAlign.Center)
        .borderRadius(15)
        .accessibilityText($r('app.string.common_copy'))
        .onClick(() => this.onCopy())

        Column() {
          AAIcon({
            commands: AA_ICONS.SQUARE_ARROW_OUT_UP_RIGHT,
            iconSize: 16,
            color: this.colors.muted,
          })
        }
        .width(30)
        .height(30)
        .justifyContent(FlexAlign.Center)
        .borderRadius(15)
        .accessibilityText($r('app.string.session_share'))
        .onClick(() => this.onShare())
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 4, right: 4, top: 3 })
    .alignItems(HorizontalAlign.Start)
  }
}
