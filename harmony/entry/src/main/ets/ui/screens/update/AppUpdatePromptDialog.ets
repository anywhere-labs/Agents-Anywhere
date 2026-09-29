import { AAColors, AA_LIGHT_COLORS, withAlpha } from '../../designsystem/AAColors';
import { AndroidAppRelease } from '../../../api/AppUpdatesApi';
import { AppUpdateState } from '../../../feature/update/AppUpdateController';

/**
 * The update prompt.
 *
 * Port of `ui/screens/update/AppUpdatePromptDialog.kt`.
 *
 * A modal that cannot be dismissed by tapping outside or by the back gesture —
 * the user has to choose "Ignore this version" or "Update now". The download and
 * install states Android can show while a HAP is fetched are gone with the
 * install step itself (see the deviation table); what remains is the release
 * offer, the two failure lines, and the two buttons.
 */

@Component
export struct AppUpdatePromptDialog {
  colors: AAColors = AA_LIGHT_COLORS;
  state: AppUpdateState = AppUpdateState.empty();
  onUpdate: () => void = () => {};
  onIgnore: () => void = () => {};

  build() {
    if (this.state.promptVisible && this.state.release !== null) {
      Column() {
        Column({ space: 16 }) {
          Text($r('app.string.update_available_title'))
            .fontSize(20)
            .lineHeight(24)
            .fontWeight(600)
            .fontColor(this.colors.ink)
            .width('100%')

          Text($r('app.string.update_available_message',
            (this.state.release as AndroidAppRelease).versionName))
            .fontSize(14)
            .lineHeight(20)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.colors.muted)
            .width('100%')

          if (this.state.ignoreFailed) {
            Text($r('app.string.update_ignore_failed'))
              .fontSize(13)
              .lineHeight(18)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.colors.errorText)
              .width('100%')
          }

          if (this.state.downloadUnavailable) {
            Text($r('app.string.update_download_unavailable'))
              .fontSize(13)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.colors.errorText)
              .width('100%')
          }

          Row({ space: 10 }) {
            this.DialogButton($r('app.string.update_ignore_version'), false)
            this.DialogButton($r('app.string.update_now'), true)
          }
          .width('100%')
        }
        .width('100%')
        .padding(20)
        .borderRadius(20)
        .backgroundColor(this.colors.dialogSurface)
        .border({ width: 1, color: this.colors.border })
        .alignItems(HorizontalAlign.Start)
        // A tap on the card must not dismiss the prompt; only the buttons act.
        .onClick(() => {})
      }
      .width('100%')
      .height('100%')
      .padding({ left: 22, right: 22 })
      .backgroundColor(this.colors.isDark ? '#8F000000' : '#47000000')
      .justifyContent(FlexAlign.Center)
    }
  }

  /** The 46dp dialog button, in the secondary or primary variant. */
  @Builder
  DialogButton(label: ResourceStr, primary: boolean) {
    Text(label)
      .fontSize(14)
      .fontWeight(600)
      .fontColor(primary
        ? withAlpha(this.colors.onPrimaryAction, this.state.busy() ? 0.55 : 1)
        : withAlpha(this.colors.ink, this.state.busy() ? 0.55 : 1))
      .textAlign(TextAlign.Center)
      .layoutWeight(1)
      .height(46)
      .borderRadius(14)
      .backgroundColor(primary
        ? withAlpha(this.colors.primaryAction, this.state.busy() ? 0.42 : 1)
        : this.colors.secondaryActionSurface)
      .onClick(() => {
        if (this.state.busy()) {
          return;
        }
        if (primary) {
          this.onUpdate();
        } else {
          this.onIgnore();
        }
      })
  }
}
